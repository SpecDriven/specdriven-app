// A plugin's own settings (src/plugins/host/pluginSettings.ts, specs/agents/
// agent-plugins.feature.md "The Settings page shows a plugin's section"):
// a section under the plugin's id in settings.json, patched through the
// service its host half gets or through `PUT /api/state`'s pluginSettings,
// checked for shape only, with the keys a plugin had at the top of the file
// adopted once.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../src/server/api";
import { readState, writeState } from "../src/server/state";
import {
  PLUGIN_SETTINGS_MAX_BYTES,
  applyPluginPatch,
  createPluginSettings,
  pluginPatchRefusal,
  pluginSection,
  pluginSettingsOf,
} from "../src/plugins/host/pluginSettings";
import { hostConfigFor } from "../src/plugins/host/loader";

let root: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realHosted = process.env.SPECDRIVEN_HOSTED;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-plugin-settings-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.SPECDRIVEN_HOSTED;
  await writeState({ dataRepo: join(root, "data") }, root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["SPECDRIVEN_HOSTED", realHosted],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(method: string, body?: unknown): Promise<Response> {
  return handleApi(
    new Request("http://localhost/api/state", {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

test("a patch merges into the plugin's section, null removes a key, and an emptied section goes", () => {
  const state: Record<string, unknown> = {};
  expect(applyPluginPatch(state, "acme", { a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  expect(applyPluginPatch(state, "acme", { a: 2, c: undefined })).toEqual({ a: 2, b: "x" });
  expect(pluginSettingsOf(state)).toEqual({ acme: { a: 2, b: "x" } });
  expect(pluginSection(state, "acme")).toEqual({ a: 2, b: "x" });
  expect(pluginSection(state, "other")).toEqual({});
  applyPluginPatch(state, "acme", { a: null, b: null });
  expect("pluginSettings" in state).toBe(false);
  // A malformed map reads as empty.
  expect(pluginSettingsOf({ pluginSettings: [1] })).toEqual({});
  expect(pluginSettingsOf({ pluginSettings: { acme: "no", ok: { k: 1 } } })).toEqual({ ok: { k: 1 } });
});

test("the shape is checked, never the keys", () => {
  expect(pluginPatchRefusal({ anything: ["goes"] })).toBeNull();
  expect(pluginPatchRefusal("x")).toContain("object");
  expect(pluginPatchRefusal([1])).toContain("object");
  expect(pluginPatchRefusal(null)).toContain("object");
  expect(pluginPatchRefusal({ big: "x".repeat(PLUGIN_SETTINGS_MAX_BYTES) })).toContain("16 KB");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(pluginPatchRefusal(cyclic)).toContain("JSON");
});

test("the service a host half gets reads, writes and adopts its section of the settings file", async () => {
  const settings = createPluginSettings("acme", {
    readState: async () => (await readState(root)) as Record<string, unknown>,
    writeState: (s) => writeState(s, root),
  });
  expect(await settings.read()).toEqual({});
  await settings.write({ token: "t", retries: 3 });
  expect(await settings.read()).toEqual({ token: "t", retries: 3 });
  await settings.write({ retries: null });
  expect(await settings.read()).toEqual({ token: "t" });
  await expect(settings.write("nope" as never)).rejects.toThrow(/object/);
  const file = JSON.parse(await readFile(join(root, ".specdriven", "settings.json"), "utf8")) as Record<string, unknown>;
  expect(file.pluginSettings).toEqual({ acme: { token: "t" } });

  // Adoption: the named top-level keys come in once, those already in the
  // section are left alone, and the old keys stay in the file.
  await writeState({ ...(await readState(root)), acmeMode: "fast", acmeUrl: "http://a" } as never, root);
  await settings.adopt(["acmeMode", "acmeUrl", "acmeMissing"]);
  expect(await settings.read()).toEqual({ token: "t", acmeMode: "fast", acmeUrl: "http://a" });
  await writeState({ ...(await readState(root)), acmeMode: "slow" } as never, root);
  await settings.adopt(["acmeMode"]);
  expect((await settings.read()).acmeMode).toBe("fast");
  expect(((await readState(root)) as Record<string, unknown>).acmeMode).toBe("slow");
  // The loader builds the same service for a built-in, by its manifest.
  const config = hostConfigFor({ id: "other", api: "1", displayName: "Other", description: "", defaultEnabled: true }, "");
  expect(config.dir).toBe("");
  expect(await config.settings.read()).toEqual({});
  expect(typeof config.secrets("token").load).toBe("function");
});

test("PUT /api/state takes a patch per plugin id, GET reports the sections, and the hosted app refuses", async () => {
  const put = await api("PUT", { pluginSettings: { acme: { a: 1 }, other: { b: [true] } } });
  expect(put.status).toBe(200);
  expect(((await put.json()) as { pluginSettings: unknown }).pluginSettings).toEqual({ acme: { a: 1 }, other: { b: [true] } });
  const again = await api("PUT", { pluginSettings: { acme: { a: null, c: "x" } } });
  expect(((await again.json()) as { pluginSettings: unknown }).pluginSettings).toEqual({ acme: { c: "x" }, other: { b: [true] } });
  expect(((await (await api("GET")).json()) as { pluginSettings: unknown }).pluginSettings).toEqual({ acme: { c: "x" }, other: { b: [true] } });
  expect((await readState(root)).pluginSettings).toEqual({ acme: { c: "x" }, other: { b: [true] } });

  const bad = await api("PUT", { pluginSettings: { acme: "x" } });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("pluginSettings.acme");
  expect((await api("PUT", { pluginSettings: [] })).status).toBe(400);

  process.env.SPECDRIVEN_HOSTED = "1";
  const hosted = await api("PUT", { pluginSettings: { acme: { a: 1 } } });
  expect(hosted.status).toBe(403);
  expect((await hosted.json()).error).toContain("Plugin settings");
});
