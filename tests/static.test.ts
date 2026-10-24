// Automates specs/app/desktop-app.feature.md: the app:// protocol serves
// bundled renderer files by url path, and anything else — deep links included —
// falls back to the app shell.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mimeType, shellHtml, staticFilePath } from "../src/electron/static";

const ROOT = "/pkg/dist/renderer";

describe("mimeType", () => {
  test("common bundle types", () => {
    expect(mimeType("chunk-abc.js")).toBe("text/javascript; charset=utf-8");
    expect(mimeType("index.css")).toBe("text/css; charset=utf-8");
    expect(mimeType("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeType("inter.woff2")).toBe("font/woff2");
    expect(mimeType("logo.SVG")).toBe("image/svg+xml");
  });

  test("unknown extensions are opaque bytes", () => {
    expect(mimeType("archive.bin")).toBe("application/octet-stream");
    expect(mimeType("no-extension")).toBe("application/octet-stream");
  });
});

describe("staticFilePath", () => {
  test("the root path is the shell", () => {
    expect(staticFilePath(ROOT, "/")).toBe(join(ROOT, "index.html"));
  });

  test("bundle files resolve inside the renderer directory", () => {
    expect(staticFilePath(ROOT, "/chunk-abc.js")).toBe(join(ROOT, "chunk-abc.js"));
    expect(staticFilePath(ROOT, "/assets/inter.woff2")).toBe(join(ROOT, "assets/inter.woff2"));
  });

  test("deep links resolve to paths that won't exist, so the caller serves the shell", () => {
    expect(staticFilePath(ROOT, "/features/billing%2Fquote.feature.md")).toBe(
      join(ROOT, "features/billing/quote.feature.md"),
    );
  });

  test("escapes and smuggled separators are rejected", () => {
    expect(staticFilePath(ROOT, "/../settings.json")).toBeNull();
    expect(staticFilePath(ROOT, "/%2e%2e/settings.json")).toBeNull();
    expect(staticFilePath(ROOT, "/a//b.js")).toBeNull();
    expect(staticFilePath(ROOT, "/a%5Cb.js")).toBeNull();
    expect(staticFilePath(ROOT, "/%ZZ")).toBeNull();
  });
});

// specs/ui/navigation.feature.md "links from outside the app": the shell
// is served at deep links too, where index.html-relative asset urls would
// resolve under the link's path and come back as the shell itself.
describe("shellHtml", () => {
  const built =
    '<link rel="icon" type="image/svg+xml" href="./icon-hyx7xsma.svg" />\n' +
    '<link rel="stylesheet" crossorigin href="./index-kj5vcw85.css">' +
    '<script type="module" crossorigin src="./index-s1502frg.js"></script>';

  test("the built shell's ./ asset urls become root-relative, so they load at any path", () => {
    const html = shellHtml(built);
    expect(html).toContain('href="/icon-hyx7xsma.svg"');
    expect(html).toContain('href="/index-kj5vcw85.css"');
    expect(html).toContain('src="/index-s1502frg.js"');
    expect(html).not.toContain('"./');
    // Which is what the module script at app://specdriven/features/app/desktop-app resolves against.
    expect(new URL("/index-s1502frg.js", "app://specdriven/features/app/desktop-app").href).toBe(
      "app://specdriven/index-s1502frg.js",
    );
  });

  test("absolute, remote and parent-relative urls pass through untouched", () => {
    const html =
      '<script src="/already.js"></script><a href="https://example.com/./x">x</a>' +
      '<img src=\'../up.png\'><link href="data:text/css,./y">';
    expect(shellHtml(html)).toBe(html);
  });

  test("single-quoted attributes are rewritten too", () => {
    expect(shellHtml("<script src='./a.js'></script>")).toBe("<script src='/a.js'></script>");
  });
});
