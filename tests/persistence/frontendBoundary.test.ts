// Effect and the services built on it stay on the server. The browser
// bundle is built from src/index.html's entry; nothing it imports for its
// value — directly or through another module — may be `effect`, an
// `@effect/*` package, or a file under src/server/persistence,
// src/server/sync or src/server/effect. A type-only import is erased before
// bundling and does not count.
//
// The Promise facades (fsx.ts, automerge/store.ts, state.ts, tokenStore.ts,
// secrets.ts, siteTokens.ts and the four per-site token files, run.ts,
// git/index.ts, reload.ts, shutdown.ts) run on Effect, so one of them
// reaching the frontend would carry the whole runtime into the page; this
// walk names the chain if it ever happens.
//
// The Confluence MCP server (src/mcp) is a bundle of its own that the
// desktop app starts beside every agent session. It reads a token file and
// calls the wiki; it has no use for the storage core, so it stays clear of
// it too.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { chain, effectReached, reachableFrom, ROOT } from "../helpers/importWalk";

const ENTRY = join(ROOT, "src/frontend/main.tsx");

test("the browser bundle reaches neither Effect nor the storage core", () => {
  const { cameFrom, packages } = reachableFrom(ENTRY);
  // The walk really followed the app: the entry leads to shared server modules.
  expect(cameFrom.size).toBeGreaterThan(100);
  expect(cameFrom.has(join(ROOT, "src/server/parser.ts"))).toBe(true);
  expect(packages.has("react")).toBe(true);

  expect(effectReached({ cameFrom, packages })).toEqual([]);

  const facades = [
    "fsx.ts",
    "state.ts",
    "automerge/store.ts",
    "tokenStore.ts",
    "secrets.ts",
    "siteTokens.ts",
    "jiraTokens.ts",
    "confluenceTokens.ts",
    "ahaTokens.ts",
    "qtestTokens.ts",
    "run.ts",
    "git/index.ts",
    "reload.ts",
    "shutdown.ts",
  ]
    .map((name) => join(ROOT, "src/server", name))
    .filter((file) => cameFrom.has(file))
    .map((file) => chain(cameFrom, file));
  expect(facades).toEqual([]);
});

test("the Confluence MCP server reaches neither Effect nor the storage core", () => {
  const reached = reachableFrom(join(ROOT, "src/mcp/confluence.ts"));
  // The walk really followed the server: it reads token records and calls the wiki.
  expect(reached.cameFrom.has(join(ROOT, "src/server/siteTokenModel.ts"))).toBe(true);
  expect(reached.cameFrom.has(join(ROOT, "src/server/confluence.ts"))).toBe(true);
  expect(effectReached(reached)).toEqual([]);
});
