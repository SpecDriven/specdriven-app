// Makes the specs/ symlink resolve in a Claude Code cloud session.
//
// specs/ points at ../specs-specdriven/specs. A cloud session clones only the
// repositories selected for it, so unless the spec repo was selected too, the
// symlink dangles. This SessionStart hook clones it beside the checkout.
//
//   bun scripts/ensure-specs.ts    Claude Code hook (.claude/settings.json)
//
// It does nothing outside a cloud session, or when specs/ already resolves.
// A hook must never get in the way of the session it starts, so it always exits 0.

import { existsSync } from "node:fs";
import { join } from "node:path";

const SPEC_REPO = "https://github.com/SpecDriven/specs-specdriven";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (process.env.CLAUDE_CODE_REMOTE === "true" && !existsSync(join(root, "specs"))) {
  const target = join(root, "..", "specs-specdriven");
  const r = Bun.spawnSync(["git", "clone", "--depth", "1", SPEC_REPO, target], {
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode === 0) console.log(`Cloned the spec repo to ${target}; specs/ now resolves.`);
  else console.error(`ensure-specs: could not clone ${SPEC_REPO}: ${r.stderr.toString().trim()}`);
}
