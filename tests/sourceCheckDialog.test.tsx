// The source-check dialog (src/frontend/SourceCheckDialog.tsx): before a
// session starts in a code repo it shows how the branch stands against its
// remote of record and offers a merge, a rebase, or to start as-is — offline
// or local-only, only the state and a confirm (specs/agents/
// agent-plugins.feature.md "A coding session should check that source is up to
// date"). The summary and the button set are pure, so the right words and the
// right buttons per state are checked without a DOM (bun test has none).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceCheckFields, canRefresh, refreshHint, sourceSummary } from "../src/frontend/SourceCheckDialog";
import type { SourceStatus } from "../src/frontend/agentChat";

const noop = () => undefined;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!);

const base: SourceStatus = {
  repo: "/code",
  branch: "main",
  upstream: "origin/main",
  online: true,
  hasRemote: true,
  detached: false,
  behind: 0,
  ahead: 0,
  dirty: false,
};

const behind: SourceStatus = { ...base, behind: 2 };
const offline: SourceStatus = { ...base, behind: 1, online: false, reason: "Could not reach origin — showing the last known state" };
const localOnly: SourceStatus = { ...base, upstream: undefined, hasRemote: false, reason: "The branch has no upstream — local only" };
const detached: SourceStatus = { ...base, branch: undefined, detached: true, reason: "HEAD is detached — no branch to refresh" };
const dirtyBehind: SourceStatus = { ...base, behind: 1, dirty: true };

describe("sourceSummary", () => {
  test("names how far behind and ahead the branch is of its upstream", () => {
    expect(sourceSummary(behind)).toContain("2 behind origin/main");
    expect(sourceSummary({ ...base, ahead: 1 })).toContain("1 ahead of origin/main");
    expect(sourceSummary(base)).toContain("up to date with origin/main");
  });
  test("flags an offline (last-known) comparison and uncommitted changes", () => {
    expect(sourceSummary(offline)).toContain("last known");
    expect(sourceSummary(dirtyBehind)).toContain("uncommitted changes");
  });
  test("says local-only and detached in words, with no upstream talk", () => {
    expect(sourceSummary(localOnly)).toContain("local only");
    expect(sourceSummary(detached)).toContain("detached HEAD");
  });
});

describe("canRefresh", () => {
  test("is on only with a remote, a clean tree, online, and a branch", () => {
    expect(canRefresh(behind)).toBe(true);
    expect(canRefresh(offline)).toBe(false);
    expect(canRefresh(localOnly)).toBe(false);
    expect(canRefresh(detached)).toBe(false);
    expect(canRefresh(dirtyBehind)).toBe(false);
  });
});

describe("refreshHint", () => {
  test("explains why a refresh is off when there is a remote but it cannot run", () => {
    expect(refreshHint(dirtyBehind)).toContain("stash");
    expect(refreshHint(offline)).toContain("could not be reached");
    expect(refreshHint(behind)).toBeNull();
    expect(refreshHint(localOnly)).toBeNull();
  });
});

describe("SourceCheckFields", () => {
  test("a behind branch offers Rebase, Update, Start anyway, and Cancel", () => {
    const markup = html(<SourceCheckFields status={behind} onRefresh={noop} onStartAnyway={noop} onCancel={noop} />);
    const labels = buttons(markup);
    expect(labels).toContain("Cancel");
    expect(labels).toContain("Start anyway");
    expect(labels.some((l) => l.includes("Rebase"))).toBe(true);
    expect(labels.some((l) => l.includes("Update"))).toBe(true);
    expect(markup).toContain(sourceSummary(behind));
  });

  test("offline and local-only drop the refresh buttons and keep confirm-or-cancel", () => {
    for (const status of [offline, localOnly, detached, dirtyBehind]) {
      const labels = buttons(html(<SourceCheckFields status={status} onRefresh={noop} onStartAnyway={noop} onCancel={noop} />));
      expect(labels).toEqual(["Cancel", "Start anyway"]);
    }
  });

  test("the why-off hint shows when a refresh is blocked, not when it is available", () => {
    expect(html(<SourceCheckFields status={dirtyBehind} onRefresh={noop} onStartAnyway={noop} onCancel={noop} />)).toContain(
      "start-off",
    );
    expect(html(<SourceCheckFields status={behind} onRefresh={noop} onStartAnyway={noop} onCancel={noop} />)).not.toContain(
      "start-off",
    );
  });

  test("busy disables every action so a refresh cannot be double-run", () => {
    const markup = html(<SourceCheckFields status={behind} onRefresh={noop} onStartAnyway={noop} onCancel={noop} busy />);
    const disabled = [...markup.matchAll(/<button[^>]*>/g)].every((m) => m[0]!.includes("disabled"));
    expect(disabled).toBe(true);
  });
});
