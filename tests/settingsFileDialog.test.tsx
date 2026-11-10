// "View settings file…" (specs/app/user-info-settings.feature.md "view the
// settings file"): SettingsFileDialog as static markup — the path from ~,
// labelled values instead of JSON, and the no-file state. App.tsx owns the
// fetch and the open state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsFileDialog, type SettingsFile } from "../src/frontend/SettingsFileDialog";

const noop = () => {};
const file = (over: Partial<SettingsFile> = {}): SettingsFile => ({
  path: "/Users/ann/.specdriven/settings.json",
  home: "/Users/ann",
  exists: true,
  settings: {
    dataRepo: "/Users/ann/dev/specs",
    featureFlags: true,
    reloadFrequencySeconds: 60,
    recentFolders: [{ path: "/Users/ann/dev/specs", kind: "spec" }],
  },
  ...over,
});

describe("SettingsFileDialog", () => {
  test("shows ~/.specdriven/settings.json as labelled sections, not JSON", () => {
    const markup = renderToStaticMarkup(<SettingsFileDialog file={file()} onClose={noop} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Settings file"');
    expect(markup).toContain("~/.specdriven/settings.json");
    expect(markup).toContain("<h4>Folders</h4>");
    expect(markup).toContain("Specifications folder");
    expect(markup).toContain("Feature flags</dt><dd><span>On</span>");
    expect(markup).toContain("60 seconds");
    expect(markup).toContain("~/dev/specs (specifications)");
    // No JSON syntax: no braces, no quoted keys.
    expect(markup).not.toMatch(/[{}]/);
    expect(markup).not.toContain("&quot;featureFlags&quot;");
    expect(markup).not.toContain("reloadFrequencySeconds");
  });

  test("offers Copy contents beside Close", () => {
    const markup = renderToStaticMarkup(<SettingsFileDialog file={file()} onClose={noop} />);
    expect(markup).toContain(">Copy contents</button>");
    const empty = renderToStaticMarkup(<SettingsFileDialog file={file({ exists: false, settings: {} })} onClose={noop} />);
    expect(empty).not.toContain("Copy contents");
  });

  test("without the file, it says there is none yet", () => {
    const markup = renderToStaticMarkup(
      <SettingsFileDialog file={file({ exists: false, settings: {} })} onClose={noop} />,
    );
    expect(markup).toContain("No settings file yet");
    expect(markup).toContain("~/.specdriven/settings.json");
  });

  test("names the file the app reads when a project settings file is in effect", () => {
    const markup = renderToStaticMarkup(
      <SettingsFileDialog file={file({ activePath: "/Users/ann/dev/app/.specdriven/settings.json" })} onClose={noop} />,
    );
    expect(markup).toContain("The app is currently reading ~/dev/app/.specdriven/settings.json instead.");
  });

  test("a file that is not JSON says so", () => {
    const markup = renderToStaticMarkup(
      <SettingsFileDialog file={file({ settings: {}, error: "The file is not valid JSON." })} onClose={noop} />,
    );
    expect(markup).toContain("The file is not valid JSON.");
  });
});
