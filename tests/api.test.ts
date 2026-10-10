// Automates specs/desktop-app.spec.md: the API route table is matched by a
// runtime-agnostic matcher so Bun.serve (web) and the app:// protocol
// (desktop) serve identical routes.

import { describe, expect, test } from "bun:test";
import { matchApi } from "../src/server/api";
import { syncPlugins } from "../src/plugins/host/loader";

describe("matchApi", () => {
  test("literal routes match by method", () => {
    expect(matchApi("GET", "/api/state")).not.toBeNull();
    expect(matchApi("PUT", "/api/state")).not.toBeNull();
    expect(matchApi("POST", "/api/reload")).not.toBeNull();
    expect(matchApi("DELETE", "/api/state")).toBeNull();
    expect(matchApi("GET", "/api/reload")).toBeNull();
  });

  test("search route matches GET only (specs/search.spec.md)", () => {
    expect(matchApi("GET", "/api/search")).not.toBeNull();
    expect(matchApi("POST", "/api/search")).toBeNull();
  });

  // The data repo's own settings (specs/app/specs-authorship.feature.md):
  // `authors-in-markdown` is written with a PUT, read with the listing.
  test("project settings route matches PUT only", () => {
    expect(matchApi("PUT", "/api/project-settings")).not.toBeNull();
    expect(matchApi("GET", "/api/project-settings")).toBeNull();
  });

  // GitHub sign-in routes (specs/git-operations.spec.md): device-flow
  // start and poll, browser-flow start/poll/callback, plus sign-out.
  test("auth routes match by method", () => {
    expect(matchApi("POST", "/api/auth/github/start")).not.toBeNull();
    expect(matchApi("POST", "/api/auth/github/poll")).not.toBeNull();
    expect(matchApi("POST", "/api/auth/github/web/start")).not.toBeNull();
    expect(matchApi("POST", "/api/auth/github/web/poll")).not.toBeNull();
    expect(matchApi("GET", "/api/auth/github/callback")).not.toBeNull();
    expect(matchApi("POST", "/api/auth/github/callback")).toBeNull();
    expect(matchApi("DELETE", "/api/auth/github")).not.toBeNull();
    expect(matchApi("GET", "/api/auth/github")).toBeNull();
    expect(matchApi("POST", "/api/auth/github")).toBeNull();
  });

  // Image upload + serving (specs/images.spec.md).
  test("image routes match by method", () => {
    expect(matchApi("POST", "/api/images")).not.toBeNull();
    expect(matchApi("GET", "/api/images")).toBeNull();
    const get = matchApi("GET", "/api/images/shot-1a2b3c4d.png");
    expect(get).not.toBeNull();
    expect(get!.params).toEqual({ name: "shot-1a2b3c4d.png" });
    expect(matchApi("POST", "/api/images/shot-1a2b3c4d.png")).toBeNull();
  });

  // Roadmap pages (specs/app/roadmap.feature.md): the folder's listing, a
  // page by name, and creating one.
  // A special folder is a plugin (src/plugins/builtin/pages/host.ts): its
  // routes are there while its switch mounts it, and gone — 404 — when not.
  test("roadmap routes match by method", async () => {
    await syncPlugins({ roadmap: false });
    expect(matchApi("GET", "/api/roadmap")).toBeNull();
    await syncPlugins({ roadmap: true });
    expect(matchApi("GET", "/api/roadmap")).not.toBeNull();
    expect(matchApi("POST", "/api/roadmap")).not.toBeNull();
    expect(matchApi("DELETE", "/api/roadmap")).toBeNull();
    const page = matchApi("GET", "/api/roadmap/roadmap%2Fpricing.md");
    expect(page).not.toBeNull();
    expect(page!.params).toEqual({ file: "roadmap/pricing.md" });
    expect(matchApi("PUT", "/api/roadmap/roadmap%2Fpricing.md")).not.toBeNull();
  });

  // The engineering notebook (specs/app/engineering-notebook.feature.md): the
  // page routes over its folder, plus the two metadata writes its header
  // offers. The `/kind` and `/supersedes` routes must win over `/:file`,
  // which the first-match table gives them by sitting above it.
  test("notebook routes match by method", async () => {
    // On unless switched off; the tasks folder's estimate and the roadmap's
    // rename need their switches.
    await syncPlugins({ notebook: false });
    expect(matchApi("GET", "/api/notebook")).toBeNull();
    await syncPlugins({ tasks: true, roadmap: true });
    expect(matchApi("GET", "/api/notebook")).not.toBeNull();
    expect(matchApi("POST", "/api/notebook")).not.toBeNull();
    expect(matchApi("DELETE", "/api/notebook")).toBeNull();
    const entry = matchApi("GET", "/api/notebook/notebook%2F2026-09-12-spec-first.md");
    expect(entry).not.toBeNull();
    expect(entry!.params).toEqual({ file: "notebook/2026-09-12-spec-first.md" });
    expect(matchApi("PUT", "/api/notebook/notebook%2F2026-09-12-spec-first.md")).not.toBeNull();
    expect(matchApi("DELETE", "/api/notebook/notebook%2F2026-09-12-spec-first.md")).not.toBeNull();
    const kind = matchApi("PUT", "/api/notebook/notebook%2F2026-09-12-spec-first.md/kind");
    expect(kind).not.toBeNull();
    expect(kind!.params).toEqual({ file: "notebook/2026-09-12-spec-first.md" });
    // Renaming a page moves its file (issue #122), so every page folder has
    // the route and it too must sit above `/:file`.
    const rename = matchApi("POST", "/api/notebook/notebook%2F2026-09-12-spec-first.md/rename");
    expect(rename).not.toBeNull();
    expect(rename!.params).toEqual({ file: "notebook/2026-09-12-spec-first.md" });
    expect(matchApi("POST", "/api/roadmap/roadmap%2Fpricing.md/rename")).not.toBeNull();
    expect(matchApi("POST", "/api/tasks/tasks%2Fship-v2.md/rename")).not.toBeNull();
    expect(matchApi("GET", "/api/notebook/notebook%2F2026-09-12-spec-first.md/rename")).toBeNull();
    // A task's estimate (specs/app/tasks.feature.md "Add task to Google
    // Calendar"): one more segment under the task's file, POST only.
    const estimate = matchApi("POST", "/api/tasks/tasks%2Fship-v2.md/estimate");
    expect(estimate).not.toBeNull();
    expect(estimate!.params).toEqual({ file: "tasks/ship-v2.md" });
    expect(matchApi("GET", "/api/tasks/tasks%2Fship-v2.md/estimate")).toBeNull();
    expect(
      matchApi("PUT", "/api/notebook/notebook%2F2026-09-12-spec-first.md/supersedes"),
    ).not.toBeNull();
    expect(matchApi("GET", "/api/notebook/notebook%2Fx.md/kind")).toBeNull();
  });

  // Test management (specs/app/tests.feature.md): one read of the
  // whole module, and a write per entity.
  // GitHub issues (specs/app/github-issues.feature.md): list and create,
  // one issue read and edited, and its comments added to.
  test("issue routes match by method", async () => {
    // The module is a plugin: its routes exist while the switch mounts it.
    await syncPlugins({ issues: false });
    expect(matchApi("GET", "/api/issues")).toBeNull();
    await syncPlugins({ issues: true });
    expect(matchApi("GET", "/api/issues")).not.toBeNull();
    expect(matchApi("POST", "/api/issues")).not.toBeNull();
    expect(matchApi("DELETE", "/api/issues")).toBeNull();
    expect(matchApi("GET", "/api/issues/12")!.params).toEqual({ number: "12" });
    expect(matchApi("PUT", "/api/issues/12")!.params).toEqual({ number: "12" });
    expect(matchApi("DELETE", "/api/issues/12")).toBeNull();
    expect(matchApi("POST", "/api/issues/12/comments")!.params).toEqual({ number: "12" });
    expect(matchApi("GET", "/api/issues/12/comments")).toBeNull();
  });

  test("test management routes match by method", async () => {
    // The module is a plugin (specs/app/plugins.feature.md): its routes are
    // there while the switch mounts it, and gone — 404 — when it does not.
    await syncPlugins({ testing: false });
    expect(matchApi("GET", "/api/tests")).toBeNull();
    await syncPlugins({ testing: true });
    expect(matchApi("GET", "/api/tests")).not.toBeNull();
    expect(matchApi("POST", "/api/tests")).toBeNull();
    expect(matchApi("GET", "/api/tests/cases")).toBeNull();
    expect(matchApi("POST", "/api/tests/cases")).not.toBeNull();
    expect(matchApi("PUT", "/api/tests/cases/c1")!.params).toEqual({ id: "c1" });
    expect(matchApi("DELETE", "/api/tests/cases/c1")).not.toBeNull();
    expect(matchApi("POST", "/api/tests/plans")).not.toBeNull();
    expect(matchApi("PUT", "/api/tests/plans/p1")!.params).toEqual({ id: "p1" });
    expect(matchApi("DELETE", "/api/tests/plans/p1")).not.toBeNull();
    expect(matchApi("POST", "/api/tests/plans/p1/executions")!.params).toEqual({ id: "p1" });
    expect(matchApi("GET", "/api/tests/plans/p1/executions")).toBeNull();
    expect(matchApi("PUT", "/api/tests/executions/e1")!.params).toEqual({ id: "e1" });
    expect(matchApi("DELETE", "/api/tests/executions/e1")).not.toBeNull();
    const result = matchApi("PUT", "/api/tests/executions/e1/results/c%2F1");
    expect(result!.params).toEqual({ id: "e1", caseId: "c/1" });
    expect(matchApi("GET", "/api/tests/executions/e1/results/c1")).toBeNull();
  });

  // Code gen session (specs/agents/claude.spec.md): the client posts the
  // session name and the selected specs.
  test("agent session route matches POST only", () => {
    expect(matchApi("POST", "/api/agent/session")).not.toBeNull();
    expect(matchApi("GET", "/api/agent/session")).toBeNull();
  });

  test("unknown paths do not match", () => {
    expect(matchApi("GET", "/api/nope")).toBeNull();
    expect(matchApi("GET", "/features/quote.feature.md")).toBeNull();
    expect(matchApi("GET", "/")).toBeNull();
  });

  test("params bind one decoded segment", () => {
    const m = matchApi("GET", "/api/features/billing%2Fquote.feature.md");
    expect(m).not.toBeNull();
    expect(m!.params).toEqual({ file: "billing/quote.feature.md" });
  });

  test("an unencoded slash is a different route, not a param", () => {
    // /api/features/billing/quote… has four segments after /api — no route
    // has that shape, so a client that forgets encodeURIComponent gets a 404
    // instead of a mangled file name.
    expect(matchApi("GET", "/api/features/billing/quote.feature.md")).toBeNull();
  });

  test("nested feature routes are distinct", () => {
    const move = matchApi("POST", "/api/features/quote.feature.md/move");
    const rename = matchApi("POST", "/api/features/quote.feature.md/rename");
    const renameFile = matchApi("POST", "/api/features/quote.feature.md/rename-file");
    const deleteDraft = matchApi("POST", "/api/features/quote.feature.md/delete-draft");
    expect(move).not.toBeNull();
    expect(rename).not.toBeNull();
    expect(renameFile).not.toBeNull();
    expect(deleteDraft).not.toBeNull();
    expect(move!.handler).not.toBe(rename!.handler);
    expect(rename!.handler).not.toBe(renameFile!.handler);
    expect(deleteDraft!.handler).not.toBe(move!.handler);
    expect(move!.params).toEqual({ file: "quote.feature.md" });
  });

  // Draft deletion (specs/ui.spec.md "Scenario editor"): POST, so the
  // scenario's name and version can ride in the body.
  test("the draft delete route matches POST only", () => {
    expect(matchApi("POST", "/api/features/quote.feature.md/delete-draft")).not.toBeNull();
    expect(matchApi("DELETE", "/api/features/quote.feature.md/delete-draft")).toBeNull();
    expect(matchApi("GET", "/api/features/quote.feature.md/delete-draft")).toBeNull();
    expect(
      matchApi("POST", "/api/features/billing%2Fquote.feature.md/delete-draft")!.params,
    ).toEqual({ file: "billing/quote.feature.md" });
  });

  test("segment counts must match exactly", () => {
    expect(matchApi("GET", "/api/features/quote.feature.md/")).toBeNull();
    expect(matchApi("GET", "/api")).toBeNull();
  });

  test("malformed percent-encoding does not match", () => {
    expect(matchApi("GET", "/api/features/%ZZ")).toBeNull();
  });
});
