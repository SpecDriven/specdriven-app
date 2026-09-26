// The Observability page (src/frontend/ObservabilityPage.tsx): the helpers
// its requests and rows are built from, the rows as static markup, and the
// page itself driven in a borrowed DOM against a fake /api/logs — the list,
// a search reaching the server, and a verbosity change being saved.
//
// Like tests/descriptionFolderSwitch.test.tsx, only the handful of globals
// React needs are taken from happy-dom (its registrar would replace `fetch`
// and `Response` for every other test file in the process), and given back.
// react-dom decides once, at load, whether the `input` event exists — and in
// a full run another file may load it before any DOM does — so typing goes
// through the field's own onChange rather than a dispatched `input` event.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/observability" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { LogRow, ObservabilityPage, VerbosityRows } from "../src/frontend/ObservabilityPage";
import {
  DEFAULT_FILTER,
  componentChoices,
  entryLine,
  logsUrl,
  searchPattern,
  splitMatches,
  type LogEntry,
  type LogSettings,
} from "../src/frontend/observability";

const entry = (extra: Partial<LogEntry> = {}): LogEntry => ({
  time: "2026-09-26T10:00:04.000Z",
  level: "error",
  component: "reload",
  message: "Pull failed",
  attributes: { "exception.message": "network down" },
  ...extra,
});

const settings: LogSettings = {
  level: "debug",
  components: { git: "warn" },
  levels: ["debug", "info", "warn", "error"],
  known: ["git", "reload"],
  source: { kind: "file", dir: "/home/me/.specdriven/logs" },
  otel: false,
};

describe("helpers", () => {
  test("the request url leaves defaults out", () => {
    expect(logsUrl(DEFAULT_FILTER)).toBe("/api/logs?limit=500");
    expect(logsUrl({ q: " pull ", regex: true, level: "warn", component: "reload", limit: 1000 })).toBe(
      "/api/logs?q=pull&regex=1&level=warn&components=reload&limit=1000",
    );
    // No search, no regex flag.
    expect(logsUrl({ ...DEFAULT_FILTER, regex: true })).toBe("/api/logs?limit=500");
  });

  test("search marks: literal text is escaped, a bad regex marks nothing", () => {
    expect(splitMatches("a.b axb", searchPattern("a.b", false))).toEqual([
      { text: "a.b", match: true },
      { text: " axb", match: false },
    ]);
    expect(splitMatches("a.b axb", searchPattern("a.b", true)).filter((p) => p.match)).toHaveLength(2);
    expect(searchPattern("(", true)).toBeNull();
    expect(searchPattern("  ", false)).toBeNull();
    // A pattern matching the empty string must not loop.
    expect(splitMatches("abc", searchPattern("x*", true))).toEqual([{ text: "abc", match: false }]);
  });

  test("an entry copies as one log line", () => {
    expect(entryLine(entry())).toBe(
      '2026-09-26T10:00:04.000Z ERROR [reload] Pull failed exception.message="network down"',
    );
  });

  test("the component filter offers known and seen components", () => {
    expect(componentChoices(settings, [entry({ component: "netsync" })])).toEqual(["git", "netsync", "reload"]);
  });
});

describe("markup", () => {
  test("a row shows level, component and message, with the search marked", () => {
    const html = renderToStaticMarkup(
      <LogRow entry={entry()} pattern={searchPattern("pull", false)} open={false} onToggle={() => {}} onCopy={() => {}} copied={false} />,
    );
    expect(html).toContain('class="log-level log-level-error">ERROR</span>');
    expect(html).toContain("reload");
    expect(html).toContain("<mark>Pull</mark> failed");
    expect(html).toContain("exception.message=network down");
    expect(html).toContain('aria-expanded="false"');
  });

  test("an open row lists its attributes and offers to copy", () => {
    const html = renderToStaticMarkup(
      <LogRow entry={entry({ traceId: "a".repeat(32), spanId: "b".repeat(16) })} pattern={null} open onToggle={() => {}} onCopy={() => {}} copied={false} />,
    );
    expect(html).toContain("<dt>exception.message</dt><dd>network down</dd>");
    expect(html).toContain(`${"a".repeat(32)} · span ${"b".repeat(16)}`);
    expect(html).toContain("Copy line");
  });

  test("verbosity has the default level and one row per component", () => {
    const html = renderToStaticMarkup(<VerbosityRows settings={settings} saving={false} onChange={() => {}} />);
    expect(html).toContain('aria-label="Default level"');
    expect(html).toContain('aria-label="Level for git"');
    expect(html).toContain('aria-label="Level for reload"');
    expect(html).toMatch(/aria-label="Level for git"[^]*?<option value="warn" selected="">/);
    expect(html).toContain("Default (debug)");
  });
});

/** Type into a field: its value, then the onChange React gave it. */
function type(field: HTMLInputElement, value: string) {
  field.value = value;
  const key = Object.keys(field).find((k) => k.startsWith("__reactProps$"))!;
  const props = (field as unknown as Record<string, { onChange(e: unknown): void }>)[key]!;
  props.onChange({ target: field, currentTarget: field });
}

describe("the page", () => {
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  test("lists the entries, searches through the server and saves verbosity", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let current = settings;
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/logs/settings" && init?.method === "PUT") {
        current = { ...current, ...(JSON.parse(String(init.body)) as Partial<LogSettings>) };
        return Response.json(current);
      }
      if (url === "/api/logs/settings") return Response.json(current);
      const q = new URL(url, "http://x").searchParams.get("q");
      const entries = [entry(), entry({ time: "2026-09-26T10:00:03.000Z", level: "info", component: "git", message: "fetched", attributes: {} })];
      return Response.json({ entries: q ? entries.filter((e) => e.message.includes(q)) : entries, more: false, scanned: 2 });
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<ObservabilityPage onClose={() => {}} fetcher={fetcher} />));
    await flush();

    const messages = () => [...container.querySelectorAll(".log-message")].map((m) => m.textContent);
    expect(messages()).toEqual([expect.stringContaining("Pull failed"), "fetched"]);
    expect(container.textContent).toContain("2 entries, newest first");
    expect(container.textContent).toContain("/home/me/.specdriven/logs");

    // Typing settles, then the search goes to the server.
    const search = container.querySelector('input[aria-label="Search logs"]') as unknown as HTMLInputElement;
    await act(async () => type(search, "fetched"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    await flush();
    expect(calls.some((c) => c.url.includes("q=fetched"))).toBe(true);
    expect(messages()).toEqual(["fetched"]);
    expect(container.querySelector(".log-message mark")?.textContent).toBe("fetched");

    // The default level goes to the server and the answer is shown.
    const level = container.querySelector('select[aria-label="Default level"]') as unknown as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(level), "value")!.set!;
      setter.call(level, "warn");
      level.dispatchEvent(new (window as unknown as typeof globalThis).Event("change", { bubbles: true }));
    });
    await flush();
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(JSON.parse(String(put!.init!.body))).toEqual({ level: "warn" });
    expect((container.querySelector('select[aria-label="Default level"]') as unknown as HTMLSelectElement).value).toBe("warn");

    await act(async () => root.unmount());
    container.remove();
  });

  test("a refused request shows the server's reason", async () => {
    const fetcher = async () => Response.json({ error: "Logs are not available in demo mode" }, { status: 403 });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<ObservabilityPage onClose={() => {}} fetcher={fetcher} />));
    await flush();
    const alerts = [...container.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts).toContain("Logs are not available in demo mode");
    await act(async () => root.unmount());
    container.remove();
  });
});
