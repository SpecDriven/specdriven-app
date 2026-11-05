// The Project settings page (src/frontend/ProjectSettingsPage.tsx; specs/app/
// project-settings.feature.md): the helpers its typed values go through,
// and the page driven in a borrowed DOM against a fake /api/project-settings —
// the rows with their specs-link state, the symlink made and removed, the
// default picked, a repo and a member added and removed.
//
// As tests/observabilityPage.test.tsx does, only the handful of globals
// React needs are taken from happy-dom and given back after.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/project-settings" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  ProjectSettingsPage,
  codeRepoPathTyped,
  codeReposToOffer,
  memberTyped,
  specsLinkLabel,
  type ProjectSettingsData,
} from "../src/frontend/ProjectSettingsPage";

describe("typed values", () => {
  test("a bare folder name is a sibling of the data folder; paths are kept as typed", () => {
    expect(codeRepoPathTyped("acme-app")).toBe("../acme-app");
    expect(codeRepoPathTyped(" acme-app/ ")).toBe("../acme-app");
    expect(codeRepoPathTyped("../acme-app")).toBe("../acme-app");
    expect(codeRepoPathTyped("team/acme-app")).toBe("team/acme-app");
    expect(codeRepoPathTyped("/srv/acme-app/")).toBe("/srv/acme-app");
    expect(codeRepoPathTyped("C:\\code\\app")).toBe("C:\\code\\app");
    expect(codeRepoPathTyped("  ")).toBe("");
  });

  test("a member is a name, with the email in angle brackets", () => {
    expect(memberTyped("Ada Lovelace")).toEqual({ name: "Ada Lovelace" });
    expect(memberTyped("Ada Lovelace <ada@acme.example>")).toEqual({ name: "Ada Lovelace", email: "ada@acme.example" });
    expect(memberTyped("<ada@acme.example>")).toBeNull();
    expect(memberTyped("   ")).toBeNull();
  });

  test("the specs link row says what is at <code repo>/specs", () => {
    expect(specsLinkLabel({ state: "missing" }, true)).toBe("no specs symlink");
    expect(specsLinkLabel({ state: "linked", target: "../acme-specs/specs" }, true)).toBe("specs → ../acme-specs/specs");
    expect(specsLinkLabel({ state: "elsewhere", target: "/x/specs" }, true)).toContain("not this data folder");
    expect(specsLinkLabel({ state: "folder" }, true)).toContain("real folder");
    expect(specsLinkLabel({ state: "missing" }, false)).toBe("");
  });
});

/** The handlers React gave an element. */
function reactProps(el: Element): Record<string, (e: unknown) => void> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key]!;
}

function click(el: Element) {
  reactProps(el).onClick!({ target: el, currentTarget: el, preventDefault() {} });
}

function change(el: Element, checked: boolean) {
  (el as unknown as { checked: boolean }).checked = checked;
  reactProps(el).onChange!({ target: el, currentTarget: el });
}

const initial = (): ProjectSettingsData => ({
  file: "/w/acme-specs/project-settings.json",
  members: [{ name: "Ada", email: "ada@acme.example" }],
  codeRepos: [
    { path: "../acme-app", dir: "/w/acme-app", isDefault: true, exists: true, specsLink: { state: "missing" } },
    {
      path: "../acme-mobile",
      dir: "/w/acme-mobile",
      isDefault: false,
      exists: true,
      specsLink: { state: "linked", target: "../acme-specs/specs" },
    },
    { path: "../gone", dir: "/w/gone", isDefault: false, exists: false, specsLink: { state: "missing" } },
  ],
  defaultCodeRepo: "../acme-app",
  authorsInMarkdown: false,
  canEdit: true,
  canLink: true,
  canChooseFolder: false,
});

describe("the page", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  test("shows each repo's specs link and saves every change the moment it is made", async () => {
    const calls: { url: string; body: unknown }[] = [];
    let data = initial();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url === "/api/project-settings/specs-link") {
        data = {
          ...data,
          codeRepos: data.codeRepos.map((r) =>
            r.path === body.codeRepo
              ? { ...r, specsLink: body.action === "create" ? { state: "linked", target: "../acme-specs/specs" } : { state: "missing" } }
              : r,
          ),
        };
      } else if (body?.defaultCodeRepo) {
        data = { ...data, codeRepos: data.codeRepos.map((r) => ({ ...r, isDefault: r.path === body.defaultCodeRepo })) };
      } else if (body?.codeRepos) {
        data = { ...data, codeRepos: data.codeRepos.filter((r) => body.codeRepos.includes(r.path)) };
      } else if (body?.members) {
        data = { ...data, members: body.members };
      } else if (body?.authorsInMarkdown !== undefined) {
        data = { ...data, authorsInMarkdown: body.authorsInMarkdown };
      }
      return new Response(JSON.stringify(data), { status: 200 });
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let changed = 0;
    const prompts: string[] = [];
    await act(async () =>
      root.render(
        <ProjectSettingsPage
          initial={initial()}
          prompt={async (opts) => {
            prompts.push(opts.title);
            return opts.title.includes("member") ? "Grace <grace@acme.example>" : "acme-web";
          }}
          confirm={async () => true}
          onChanged={() => changed++}
          onClose={() => {}}
        />,
      ),
    );

    const rows = () => [...container.querySelectorAll('[data-testid="code-repo-row"]')];
    expect(rows().map((r) => r.querySelector("code")?.textContent)).toEqual(["../acme-app", "../acme-mobile", "../gone"]);
    expect(rows()[0]!.textContent).toContain("default");
    expect(rows()[0]!.textContent).toContain("no specs symlink");
    expect(rows()[1]!.textContent).toContain("specs → ../acme-specs/specs");
    expect(rows()[2]!.textContent).toContain("not found");
    // A folder that is not there has no symlink to speak of.
    expect(rows()[2]!.querySelector('button[aria-label^="Create the specs symlink"]')).toBeNull();

    // Create the symlink in the first repo.
    await act(async () => click(container.querySelector('button[aria-label="Create the specs symlink in ../acme-app"]')!));
    await flush();
    expect(calls.at(-1)).toEqual({
      url: "/api/project-settings/specs-link",
      body: { codeRepo: "../acme-app", action: "create" },
    });
    expect(rows()[0]!.textContent).toContain("specs → ../acme-specs/specs");
    expect(changed).toBe(1);

    // Remove the one the second repo has.
    await act(async () => click(container.querySelector('button[aria-label="Remove the specs symlink from ../acme-mobile"]')!));
    await flush();
    expect(calls.at(-1)!.body).toEqual({ codeRepo: "../acme-mobile", action: "remove" });
    expect(rows()[1]!.textContent).toContain("no specs symlink");

    // Make the second repo the default.
    await act(async () => change(container.querySelector('input[aria-label="Make ../acme-mobile the default code repo"]')!, true));
    await flush();
    expect(calls.at(-1)).toEqual({ url: "/api/project-settings", body: { defaultCodeRepo: "../acme-mobile" } });
    expect(rows()[1]!.textContent).toContain("default");
    expect(rows()[0]!.textContent).not.toContain("default");

    // Remove the missing one: the list without it.
    await act(async () => click(container.querySelector('button[aria-label="Remove ../gone"]')!));
    await flush();
    expect(calls.at(-1)!.body).toEqual({ codeRepos: ["../acme-app", "../acme-mobile"] });
    expect(rows()).toHaveLength(2);

    // Add one by name: a sibling.
    await act(async () => click([...container.querySelectorAll("button")].find((b) => b.textContent === "Add repository…")!));
    await flush();
    expect(prompts.at(-1)).toBe("Add a code repository");
    expect(calls.at(-1)!.body).toEqual({ codeRepos: ["../acme-app", "../acme-mobile", "../acme-web"] });

    // Members: add, then remove.
    await act(async () => click([...container.querySelectorAll("button")].find((b) => b.textContent === "Add member…")!));
    await flush();
    expect(calls.at(-1)!.body).toEqual({
      members: [{ name: "Ada", email: "ada@acme.example" }, { name: "Grace", email: "grace@acme.example" }],
    });
    expect(container.textContent).toContain("grace@acme.example");
    await act(async () => click(container.querySelector('button[aria-label="Remove Ada"]')!));
    await flush();
    expect(calls.at(-1)!.body).toEqual({ members: [{ name: "Grace", email: "grace@acme.example" }] });

    // The authorship switch writes the same key Settings does.
    await act(async () => change(container.querySelector('input[aria-label="Authors in the markdown"]')!, true));
    await flush();
    expect(calls.at(-1)!.body).toEqual({ authorsInMarkdown: true });
    expect(container.textContent).toContain("/w/acme-specs/project-settings.json");

    await act(async () => root.unmount());
    container.remove();
  });

  test("a refusal shows as the error line and leaves the page as it was", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "project-settings.json is not valid JSON — fix it by hand first" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ProjectSettingsPage initial={initial()} prompt={async () => null} confirm={async () => true} onClose={() => {}} />,
      ),
    );
    await act(async () => click(container.querySelector('button[aria-label="Create the specs symlink in ../acme-app"]')!));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not valid JSON");
    expect(container.querySelectorAll('[data-testid="code-repo-row"]')[0]!.textContent).toContain("no specs symlink");
    await act(async () => root.unmount());
    container.remove();
  });

  test("a missing repo is cloned from the suggested url, shows the clone running, then is found", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const base = initial();
    const gone = { ...base.codeRepos[2]!, cloneUrl: "https://github.com/acme/gone" };
    let data: ProjectSettingsData = { ...base, canClone: true, codeRepos: [base.codeRepos[0]!, gone] };
    let polls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url === "/api/project-settings/clone") {
        data = { ...data, codeRepos: [data.codeRepos[0]!, { ...gone, clone: { url: body.url, state: "running" } }] };
      } else if (url === "/api/project-settings" && !init?.method) {
        // The second poll finds the folder there.
        if (++polls >= 2) data = { ...data, codeRepos: [data.codeRepos[0]!, { ...gone, exists: true, cloneUrl: undefined }] };
      }
      return new Response(JSON.stringify(data), { status: 200 });
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let changed = 0;
    const asked: { title: string; initial?: string; hint?: string }[] = [];
    await act(async () =>
      root.render(
        <ProjectSettingsPage
          initial={data}
          prompt={async (opts) => {
            asked.push(opts);
            return "https://github.com/acme/gone-app";
          }}
          confirm={async () => true}
          onChanged={() => changed++}
          onClose={() => {}}
        />,
      ),
    );
    const row = () => container.querySelectorAll('[data-testid="code-repo-row"]')[1]!;
    expect(row().textContent).toContain("Not on this computer");
    // A repo that is there offers no clone.
    expect(container.querySelector('button[aria-label="Clone ../acme-app"]')).toBeNull();

    await act(async () => click(container.querySelector('button[aria-label="Clone ../gone"]')!));
    await flush();
    expect(asked).toEqual([
      expect.objectContaining({ title: "Clone ../gone", initial: "https://github.com/acme/gone", hint: "It is cloned into /w/gone." }),
    ]);
    expect(calls.at(-1)).toEqual({
      url: "/api/project-settings/clone",
      body: { codeRepo: "../gone", url: "https://github.com/acme/gone-app" },
    });
    expect(row().textContent).toContain("Cloning from https://github.com/acme/gone-app…");
    expect(container.querySelector('button[aria-label="Clone ../gone"]')).toBeNull();

    // The page polls until the folder is there, then the app re-reads its listing.
    await act(async () => void (await new Promise((r) => setTimeout(r, 3300))));
    expect(row().textContent).not.toContain("not found");
    expect(row().textContent).toContain("no specs symlink");
    expect(changed).toBe(1);

    await act(async () => root.unmount());
    container.remove();
  });

  test("a failed clone shows its error with a way to try again; nothing is offered where cloning is off", async () => {
    const base = initial();
    const failed = {
      ...base.codeRepos[2]!,
      cloneUrl: "https://github.com/acme/gone",
      clone: { url: "https://github.com/acme/gone", state: "failed" as const, error: "Repository not found" },
    };
    const data: ProjectSettingsData = { ...base, canClone: true, codeRepos: [base.codeRepos[0]!, failed] };
    expect(codeReposToOffer(data).map((r) => r.path)).toEqual(["../gone"]);
    expect(codeReposToOffer({ ...data, canClone: false })).toEqual([]);
    expect(
      codeReposToOffer({ ...data, codeRepos: [{ ...failed, clone: { url: "x", state: "running" } }] }),
    ).toEqual([]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<ProjectSettingsPage initial={data} prompt={async () => null} confirm={async () => true} onClose={() => {}} />),
    );
    expect(container.textContent).toContain("Repository not found");
    expect(container.querySelector('button[aria-label="Clone ../gone"]')?.textContent).toBe("Try again…");
    await act(async () => root.unmount());
    const other = createRoot(container);
    await act(async () =>
      other.render(
        <ProjectSettingsPage
          initial={{ ...data, canClone: false }}
          prompt={async () => null}
          confirm={async () => true}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.querySelector('button[aria-label="Clone ../gone"]')).toBeNull();
    await act(async () => other.unmount());
    container.remove();
  });

  test("where the settings are read-only, the rows show and the controls do not", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ProjectSettingsPage
          initial={{ ...initial(), canEdit: false, canLink: false }}
          prompt={async () => null}
          confirm={async () => true}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-testid="code-repo-row"]')).toHaveLength(3);
    expect(container.querySelector('button[aria-label^="Create the specs symlink"]')).toBeNull();
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(container.textContent).toContain("read-only here");
    await act(async () => root.unmount());
    container.remove();
  });
});
