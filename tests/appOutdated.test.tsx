// The update screen (specs/app/data-format.feature.md) in
// src/frontend/AppOutdated.tsx: what the user is told to install and run on
// each platform, and the one place the client notices a blocked folder.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppOutdated,
  DATA_TOO_NEW_HEADER,
  upgradeInstructions,
  watchDataTooNew,
  type UpgradePlatform,
} from "../src/frontend/AppOutdated";

const noop = () => {};
const render = (platform: UpgradePlatform, minAppVersion: string | null = "0.1.160") =>
  renderToStaticMarkup(
    <AppOutdated
      appVersion="0.1.150"
      minAppVersion={minAppVersion}
      platform={platform}
      checking={false}
      onCheckAgain={noop}
      onOtherFolder={noop}
    />,
  );

describe("AppOutdated — data saved by a newer app blocks this one", () => {
  test("it names the version the folder needs and the one running", () => {
    const markup = render("unix");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("<strong>0.1.160</strong> or later");
    expect(markup).toContain("You are running 0.1.150.");
    expect(markup).toContain("Check again");
    expect(markup).toContain("Open another folder");
  });

  test("a folder that names no version still says to update", () => {
    const markup = render("unix", null);
    expect(markup).not.toContain("<strong>");
    expect(markup).toContain("Install the latest version");
  });

  test("macOS and Linux get the curl installer", () => {
    expect(render("unix")).toContain(
      "curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.sh | sh",
    );
  });

  test("Windows gets the PowerShell installer", () => {
    const markup = render("windows");
    expect(markup).toContain("In PowerShell, run:");
    expect(markup).toContain(
      "irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex",
    );
  });

  test("the desktop app points at the latest release", () => {
    expect(upgradeInstructions("desktop").command).toBeNull();
    const markup = render("desktop");
    expect(markup).not.toContain("<code");
    expect(markup).toContain(
      'href="https://github.com/SpecDriven/specdriven-app/releases/latest"',
    );
  });
});

describe("watchDataTooNew", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const answering = (headers: Record<string, string>) =>
    (async () => new Response("{}", { headers })) as unknown as typeof fetch;

  test("an answer carrying the header reports the version it asks for", async () => {
    globalThis.fetch = answering({ [DATA_TOO_NEW_HEADER]: "0.1.160" });
    const seen: (string | null)[] = [];
    const stop = watchDataTooNew((v) => seen.push(v));
    await fetch("/api/features");
    stop();
    expect(seen).toEqual(["0.1.160"]);
  });

  test("an empty header still reports, with no version", async () => {
    globalThis.fetch = answering({ [DATA_TOO_NEW_HEADER]: "" });
    const seen: (string | null)[] = [];
    const stop = watchDataTooNew((v) => seen.push(v));
    await fetch("/api/features");
    stop();
    expect(seen).toEqual([null]);
  });

  test("ordinary answers pass through, and stopping restores fetch", async () => {
    const plain = answering({});
    globalThis.fetch = plain;
    const seen: (string | null)[] = [];
    const stop = watchDataTooNew((v) => seen.push(v));
    expect(globalThis.fetch).not.toBe(plain);
    await fetch("/api/features");
    stop();
    expect(seen).toEqual([]);
    expect(globalThis.fetch).toBe(plain);
  });
});
