// Messages sent while the agent is at work (specs/agents/agent-pane
// .feature.md "A message sent while the agent works waits for the turn"):
// the engine (src/server/agentChat.ts) keeps them waiting, sends the first
// when the turn ends, and "Send now" stops the turn for one of them. Driven
// by the fake provider (tests/helpers/fakeAgent.ts), so this holds for any
// agent a plugin supplies.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  ChatError,
  endAllChatSessions,
  getChatEvents,
  getChatSession,
  removeWaitingMessage,
  sendWaitingNow,
} from "../src/server/agentChat";
import { MAX_WAITING_MESSAGES, type ChatEvent, type ChatSessionMeta } from "../src/server/agentTypes";
import { agents } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { writeState } from "../src/server/state";
import { fakeProvider, type FakeProviderOptions, type FakeSession } from "./helpers/fakeAgent";

let root: string;
let data: string;
const disposers: Disposer[] = [];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

function register(options: FakeProviderOptions = {}) {
  const fake = fakeProvider(options);
  disposers.push(agents.register(fake.provider));
  return fake;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-agent-waiting-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  data = join(root, "data");
  await writeState({ dataRepo: data }, root);
  await Bun.write(join(data, "specs", ".keep"), "");
});

afterEach(async () => {
  await endAllChatSessions();
  reloader.stop();
  for (const dispose of disposers.splice(0)) await dispose();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting; last: ${JSON.stringify(v).slice(0, 300)}`);
    await Bun.sleep(5);
  }
}

/** A session on the fake, ready to type into. */
async function ready(fake: ReturnType<typeof register>): Promise<{ id: string; session: FakeSession }> {
  const res = await api("/api/agent/chat", "POST", { name: "chat", agent: fake.provider.id });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  await until(() => getChatSession(meta.id), (m) => m?.status === "idle");
  return { id: meta.id, session: fake.sessions.at(-1)! };
}

/** Send a message; answers the event the server made of it. */
async function say(id: string, text: string, extra: Record<string, unknown> = {}): Promise<ChatEvent> {
  const res = await api(`/api/agent/chat/${id}/message`, "POST", { text, ...extra });
  expect(res.status).toBe(200);
  return ((await res.json()) as { event: ChatEvent }).event;
}

/** The agent's side of a turn's end: its result, then the host is told. */
function endTurn(session: FakeSession, isError = false): void {
  session.host.emit({
    kind: "result",
    turn: session.host.turn(),
    subtype: isError ? "error_during_execution" : "success",
    isError,
    costUsd: null,
    durationMs: 5,
    numTurns: 1,
    denials: 0,
  });
  session.host.turnEnded();
}

const kinds = (id: string) => getChatEvents(id).map((e) => e.kind);
const waitingIn = (id: string) =>
  getChatEvents(id).flatMap((e) => (e.kind === "queued" ? [e.text] : []));
const sendNow = (id: string, messageId: string) => api(`/api/agent/chat/${id}/waiting/${messageId}/send`, "POST");
const takeBack = (id: string, messageId: string) => api(`/api/agent/chat/${id}/waiting/${messageId}`, "DELETE");

test("a message sent while the agent works waits, and is sent when the turn ends", async () => {
  const fake = register();
  const { id, session } = await ready(fake);
  expect((await say(id, "go")).kind).toBe("user");
  const first = await say(id, "and then this");
  const second = await say(id, "and this");
  // Neither is refused, and neither reaches the agent yet.
  expect(first).toMatchObject({ kind: "queued", text: "and then this" });
  expect(session.sent).toEqual(["go"]);
  expect(getChatSession(id)!.status).toBe("running");
  expect(waitingIn(id)).toEqual(["and then this", "and this"]);

  // The turn ends by itself: the first one is the next turn, with no idle between.
  endTurn(session);
  await until(() => session.sent, (sent) => sent.length === 2);
  expect(session.sent).toEqual(["go", "and then this"]);
  expect(getChatSession(id)!.status).toBe("running");
  expect(session.host.turn()).toBe(2);
  // It is the same message, now sent: the log keeps the `user` event only.
  expect(waitingIn(id)).toEqual(["and this"]);
  expect(getChatEvents(id).filter((e) => e.kind === "user").at(-1)).toMatchObject({ id: (first as { id: string }).id, text: "and then this" });
  expect(kinds(id).filter((k) => k === "status")).toHaveLength(3);

  // And the one behind it after that turn; then the session is ready again.
  endTurn(session);
  await until(() => session.sent, (sent) => sent.length === 3);
  expect(session.sent.at(-1)).toBe("and this");
  expect((second as { id: string }).id).toBe((getChatEvents(id).filter((e) => e.kind === "user").at(-1) as { id: string }).id);
  endTurn(session);
  expect(getChatSession(id)!.status).toBe("idle");
  expect(waitingIn(id)).toEqual([]);
});

test("Send now stops the turn and sends the message as soon as it has stopped", async () => {
  const fake = register();
  const { id, session } = await ready(fake);
  await say(id, "go");
  const a = (await say(id, "first in line")) as { id: string };
  const b = (await say(id, "the urgent one")) as { id: string };
  // A card open on the stopped turn closes with it.
  const card = session.host.requestPermission({ toolName: "Bash", input: {}, suggestions: [] });
  expect(getChatSession(id)!.status).toBe("awaiting_input");

  expect((await sendNow(id, b.id)).status).toBe(200);
  expect(session.interrupts).toBe(1);
  expect(await card).toMatchObject({ decision: { behavior: "deny" }, via: "interrupt" });
  expect(getChatEvents(id).some((e) => e.kind === "note" && e.code === "interrupted" && e.text === "Stopped for your message.")).toBe(true);
  // Nothing goes until the agent says the turn is over.
  expect(session.sent).toEqual(["go"]);
  // A second click stops nothing twice.
  expect((await sendNow(id, b.id)).status).toBe(200);
  expect(session.interrupts).toBe(1);

  // The stopped turn ends as a failed one; the message goes all the same,
  // ahead of the one that was sent before it.
  endTurn(session, true);
  await until(() => session.sent, (sent) => sent.length === 2);
  expect(session.sent).toEqual(["go", "the urgent one"]);
  expect(getChatSession(id)!.status).toBe("running");
  expect(waitingIn(id)).toEqual(["first in line"]);

  // The session carries on: the other one follows when that turn ends.
  endTurn(session);
  await until(() => session.sent, (sent) => sent.length === 3);
  expect(session.sent.at(-1)).toBe("first in line");
  expect(getChatEvents(id).filter((e) => e.kind === "user").map((e) => (e as { id: string }).id).slice(-2)).toEqual([b.id, a.id]);
});

test("Stop sends nothing after it, and Send now on a waiting message then sends it at once", async () => {
  const fake = register();
  const { id, session } = await ready(fake);
  await say(id, "go");
  const later = (await say(id, "later")) as { id: string };
  expect((await api(`/api/agent/chat/${id}/interrupt`, "POST")).status).toBe(200);
  endTurn(session, true);
  await Bun.sleep(10);
  // The agent was stopped, not redirected: the message still waits.
  expect(getChatSession(id)!.status).toBe("idle");
  expect(session.sent).toEqual(["go"]);
  expect(waitingIn(id)).toEqual(["later"]);

  expect((await sendNow(id, later.id)).status).toBe(200);
  expect(session.interrupts).toBe(1);
  expect(session.sent).toEqual(["go", "later"]);
  expect(getChatSession(id)!.status).toBe("running");
  expect(waitingIn(id)).toEqual([]);
});

test("a turn that failed leaves the waiting messages waiting until a turn ends well", async () => {
  const fake = register();
  const { id, session } = await ready(fake);
  await say(id, "go");
  await say(id, "next");
  endTurn(session, true);
  await Bun.sleep(10);
  expect(getChatSession(id)!.status).toBe("idle");
  expect(session.sent).toEqual(["go"]);

  // A message typed now goes at once; the waiting one follows its turn.
  expect((await say(id, "try again")).kind).toBe("user");
  expect(session.sent).toEqual(["go", "try again"]);
  endTurn(session);
  await until(() => session.sent, (sent) => sent.length === 3);
  expect(session.sent.at(-1)).toBe("next");
});

test("a waiting message can be taken back, and one that is gone answers 404", async () => {
  const fake = register();
  const { id, session } = await ready(fake);
  await say(id, "go");
  const gone = (await say(id, "never mind")) as { id: string };
  expect((await takeBack(id, gone.id)).status).toBe(200);
  expect(waitingIn(id)).toEqual([]);
  expect(getChatEvents(id).at(-1)).toMatchObject({ kind: "unqueued", id: gone.id });
  endTurn(session);
  await Bun.sleep(10);
  expect(session.sent).toEqual(["go"]);
  expect(getChatSession(id)!.status).toBe("idle");

  const again = await takeBack(id, gone.id);
  expect(again.status).toBe(404);
  expect((await again.json()).error).toContain("it may have been sent");
  expect((await sendNow(id, gone.id)).status).toBe(404);
  expect((await sendNow("no-such-session", gone.id)).status).toBe(404);
});

test("an agent that cannot be stopped refuses Send now, and at most ten messages wait", async () => {
  const fake = register({ id: "bare", label: "Bare", capabilities: { canInterrupt: false } });
  const { id, session } = await ready(fake);
  await say(id, "go");
  const waits = (await say(id, "1")) as { id: string };
  const refused = await sendNow(id, waits.id);
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe("Bare cannot be interrupted — the message goes when the turn ends");
  expect(session.interrupts).toBe(0);

  for (let n = 2; n <= MAX_WAITING_MESSAGES; n++) await say(id, String(n));
  const full = await api(`/api/agent/chat/${id}/message`, "POST", { text: "one too many" });
  expect(full.status).toBe(409);
  expect((await full.json()).error).toContain(`At most ${MAX_WAITING_MESSAGES} messages can wait`);
  // The turn's end still sends them, in the order they came.
  endTurn(session);
  await until(() => session.sent, (sent) => sent.length === 2);
  expect(session.sent).toEqual(["go", "1"]);
});

test("a waiting message keeps its pasted images and hands them to the agent when it goes", async () => {
  const fake = register({ capabilities: { images: true } });
  const { id, session } = await ready(fake);
  await say(id, "go");
  const png = Buffer.from("not really a png").toString("base64");
  const queued = await say(id, "look at this", { images: [{ mediaType: "image/png", data: png, name: "shot.png" }] });
  expect(queued).toMatchObject({ kind: "queued", images: [{ mediaType: "image/png", name: "shot.png" }] });
  const shown = (queued as { images: { url: string }[] }).images[0]!.url;
  // The pane shows the picture while the message waits.
  expect((await api(shown)).status).toBe(200);
  endTurn(session);
  await until(() => session.sent, (sent) => sent.length === 2);
  expect(session.sentImages.at(-1)).toMatchObject([{ mediaType: "image/png", data: png }]);
  expect(getChatEvents(id).filter((e) => e.kind === "user").at(-1)).toMatchObject({ text: "look at this", images: [{ url: shown }] });
});

test("a session that ends never sends what waited, and the log still shows it", async () => {
  const fake = register();
  const { id, session } = await ready(fake);
  await say(id, "go");
  const left = (await say(id, "too late")) as { id: string };
  session.host.ended("Fake exited.");
  await Bun.sleep(10);
  expect(getChatSession(id)!.status).toBe("ended");
  expect(session.sent).toEqual(["go"]);
  expect(waitingIn(id)).toEqual(["too late"]);
  expect((await sendNow(id, left.id)).status).toBe(409);
  expect((await takeBack(id, left.id)).status).toBe(404);
  // The routes only pass on what the engine itself refuses, and why.
  const refusal = await sendWaitingNow(id, left.id).catch((e: unknown) => e);
  expect(refusal).toBeInstanceOf(ChatError);
  expect(refusal).toMatchObject({ status: 409, message: "The session has ended" });
  expect(() => removeWaitingMessage(id, left.id)).toThrow("no such waiting message — it may have been sent");
});

test("a waiting message whose turn cannot start is noted, and the ones behind it keep waiting", async () => {
  const errors: { fail: boolean } = { fail: false };
  const fake = register();
  const { id, session } = await ready(fake);
  const send = session.send.bind(session);
  session.send = async (text, images) => {
    if (errors.fail) throw new Error("the API is down");
    return send(text, images);
  };
  await say(id, "go");
  await say(id, "second");
  await say(id, "third");
  errors.fail = true;
  endTurn(session);
  await until(() => getChatSession(id), (m) => m?.status === "idle");
  expect(session.sent).toEqual(["go"]);
  expect(getChatEvents(id).some((e) => e.kind === "note" && e.level === "error" && e.text === "the API is down")).toBe(true);
  // "second" was tried — it is in the transcript as sent — and "third" waits.
  expect(waitingIn(id)).toEqual(["third"]);
});
