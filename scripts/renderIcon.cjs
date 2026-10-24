// Runs inside Electron, started by scripts/build-icons.ts:
//
//   electron scripts/renderIcon.cjs <job.json>
//
// Rasterizes HTML pages with the app's own Chromium — the one renderer every
// build machine already has, so the icons need no image library. The job lists
// pages and, per page, the PNG files to write at which sizes:
//
//   { "canvas": 1024, "pages": [{ "html": "/abs/mac.html",
//                                 "outputs": [{ "size": 512, "file": "/abs/512.png" }] }] }
//
// One offscreen, transparent window paints every page in turn at the canvas
// size; the smaller outputs are scaled down from that (Chromium's
// best-quality resize). One window, not one per page: under a sandboxed
// shell a second window's renderer process cannot start (its Mach port
// rendezvous is refused), and one is all the job needs.
const { app, BrowserWindow } = require("electron");
const { writeFileSync, readFileSync } = require("node:fs");

const jobFile = process.argv[process.argv.length - 1];
const job = JSON.parse(readFileSync(jobFile, "utf8"));

async function render(win, page) {
  await win.loadFile(page.html);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  // One more frame so the font swap is painted before the capture.
  await new Promise((resolve) => setTimeout(resolve, 250));
  let image = await win.webContents.capturePage();
  if (image.getSize().width !== job.canvas) {
    image = image.resize({ width: job.canvas, height: job.canvas, quality: "best" });
  }
  for (const out of page.outputs) {
    const scaled =
      out.size === job.canvas ? image : image.resize({ width: out.size, height: out.size, quality: "best" });
    writeFileSync(out.file, scaled.toPNG());
  }
}

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: job.canvas,
      height: job.canvas,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
    });
    try {
      for (const page of job.pages) await render(win, page);
    } finally {
      win.destroy();
    }
    app.exit(0);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
