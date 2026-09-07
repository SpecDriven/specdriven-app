#!/usr/bin/env bun
/**
 * Cross-compiles the specdriven binary.
 *
 *   bun run build          host platform only  -> dist/specdriven
 *   bun run build:all      full matrix         -> dist/specdriven-<os>-<arch>[-baseline]
 *
 * The suffixed names are the asset names a binary release would use. Nothing
 * publishes them yet — install.sh installs the source zip release instead
 * (specs/app/installation.feature.md). See roadmap/deployment.md.
 */
import { $ } from "bun";
import { rm, mkdir } from "node:fs/promises";

type Target = {
  /** value passed to `bun build --target=` */
  bunTarget: string;
  /** release asset name, minus the `dist/` prefix and `.exe` suffix */
  asset: string;
};

const TARGETS: Target[] = [
  { bunTarget: "bun-darwin-arm64", asset: "specdriven-darwin-arm64" },
  { bunTarget: "bun-darwin-x64", asset: "specdriven-darwin-x64" },
  { bunTarget: "bun-linux-arm64", asset: "specdriven-linux-arm64" },
  { bunTarget: "bun-linux-x64", asset: "specdriven-linux-x64" },
  // Pre-2013 CPUs / older VMs lack AVX2; Bun's baseline build covers them.
  { bunTarget: "bun-linux-x64-baseline", asset: "specdriven-linux-x64-baseline" },
  { bunTarget: "bun-windows-x64", asset: "specdriven-windows-x64" },
];

const ENTRY = "src/index.ts";
const OUT_DIR = "dist";

function outfileFor(target: Target): string {
  const ext = target.bunTarget.includes("windows") ? ".exe" : "";
  return `${OUT_DIR}/${target.asset}${ext}`;
}

async function compile(target: Target | null): Promise<string> {
  const outfile = target ? outfileFor(target) : `${OUT_DIR}/specdriven`;
  const args = [
    "build",
    "--compile",
    "--production",
    "--sourcemap",
    // The Claude Agent SDK's optional per-platform binaries are never used —
    // the app runs the developer's own `claude` (src/server/agentChat.ts).
    "--external",
    "@anthropic-ai/claude-agent-sdk-*",
    ENTRY,
    "--outfile",
    outfile,
  ];
  if (target) args.splice(1, 0, `--target=${target.bunTarget}`);

  const started = performance.now();
  await $`bun ${args}`.quiet();
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  const size = (Bun.file(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${outfile}  (${size} MB, ${secs}s)`);
  return outfile;
}

const all = process.argv.includes("--all");

// A stale binary that fails to rebuild is worse than no binary: start clean.
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

if (!all) {
  console.log("Building for host platform…");
  await compile(null);
} else {
  console.log(`Cross-compiling ${TARGETS.length} targets…`);
  const outfiles: string[] = [];
  for (const target of TARGETS) {
    outfiles.push(await compile(target));
  }

  // What a binary installer would verify downloads against, in sha256sum's format.
  const sums = await $`shasum -a 256 ${outfiles}`.text();
  const normalized = sums.replace(new RegExp(`${OUT_DIR}/`, "g"), "");
  await Bun.write(`${OUT_DIR}/SHASUMS256.txt`, normalized);
  console.log(`  ✓ ${OUT_DIR}/SHASUMS256.txt`);
}
