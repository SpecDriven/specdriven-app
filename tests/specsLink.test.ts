// A code repo's `specs` symlink (src/server/specsLink.ts; specs/app/
// project-settings.feature.md "A code repo's specs symlink is created and
// removed from the editor"): its state against a data repo, made relative
// so it holds for side-by-side checkouts, removed only when it is a symlink.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpecsLink, removeSpecsLink, specsLinkStatus } from "../src/server/specsLink";

let root: string;
let data: string;
let code: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-specs-link-"));
  data = join(root, "acme-specs");
  code = join(root, "acme-app");
  await mkdir(join(data, "specs"), { recursive: true });
  await mkdir(code, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the four states are missing, linked here, linked elsewhere and a real folder", async () => {
  expect(await specsLinkStatus(code, data)).toEqual({ state: "missing" });
  expect(await specsLinkStatus(join(root, "nowhere"), data)).toEqual({ state: "missing" });

  await symlink("../acme-specs/specs", join(code, "specs"), "dir");
  expect(await specsLinkStatus(code, data)).toEqual({ state: "linked", target: "../acme-specs/specs" });

  await rm(join(code, "specs"));
  await mkdir(join(root, "other", "specs"), { recursive: true });
  await symlink(join(root, "other", "specs"), join(code, "specs"), "dir");
  expect(await specsLinkStatus(code, data)).toEqual({ state: "elsewhere", target: join(root, "other", "specs") });

  await rm(join(code, "specs"));
  await mkdir(join(code, "specs"));
  expect(await specsLinkStatus(code, data)).toEqual({ state: "folder" });
});

test("create makes a relative link to the data repo's spec tree, once", async () => {
  expect(await createSpecsLink(code, data)).toEqual({ state: "linked", target: "../acme-specs/specs" });
  expect(await readlink(join(code, "specs"))).toBe("../acme-specs/specs");
  // Deeper apart, the link still climbs to the data repo.
  const nested = join(root, "team", "mobile");
  await mkdir(nested, { recursive: true });
  expect((await createSpecsLink(nested, data)).target).toBe("../../acme-specs/specs");

  await expect(createSpecsLink(code, data)).rejects.toMatchObject({ status: 409 });
  await expect(createSpecsLink(join(root, "nowhere"), data)).rejects.toMatchObject({ status: 400 });
  await rm(join(code, "specs"));
  await writeFile(join(code, "specs"), "a file");
  await expect(createSpecsLink(code, data)).rejects.toThrow("not a symlink");
});

test("remove unlinks a symlink, whatever it points at, and refuses a real folder", async () => {
  await createSpecsLink(code, data);
  expect(await removeSpecsLink(code, data)).toEqual({ state: "missing" });
  expect(await specsLinkStatus(code, data)).toEqual({ state: "missing" });
  // Removing what is not there is nothing to do.
  expect(await removeSpecsLink(code, data)).toEqual({ state: "missing" });

  await symlink(join(root, "elsewhere"), join(code, "specs"), "dir");
  expect(await removeSpecsLink(code, data)).toEqual({ state: "missing" });

  await mkdir(join(code, "specs"));
  await writeFile(join(code, "specs", "keep.md"), "mine");
  await expect(removeSpecsLink(code, data)).rejects.toMatchObject({ status: 409 });
  expect(await specsLinkStatus(code, data)).toEqual({ state: "folder" });
});
