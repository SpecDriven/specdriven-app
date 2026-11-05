// The Project settings page (specs/app/project-settings.feature.md): the data
// repo's project-settings.json, edited in the editor pane like Settings.
// The code repositories — each with whether its folder is there, whether
// its `specs` symlink points at this data repo (made and removed here), and
// which is the default — the members, and the authorship switch. Every
// control saves itself the moment it changes, as Settings does: the file is
// checked into the data repo, so the next sync commits and pushes it.

import { useCallback, useEffect, useState } from "react";
import { AppPageLayout, PageSection } from "./AppPage";
import type { ConfirmOptions, PromptOptions } from "./ModalPrompts";

export type SpecsLinkState = "missing" | "linked" | "elsewhere" | "folder";

export interface CodeRepoRow {
  /** As the file holds it — `../acme-app`, usually. */
  path: string;
  /** Absolute. */
  dir: string;
  isDefault: boolean;
  exists: boolean;
  specsLink: { state: SpecsLinkState; target?: string };
  /** A folder that is not there: the url the app suggests cloning it from, or null with nothing to go on. */
  cloneUrl?: string | null;
  /** A clone into the folder running, or failed with its error. */
  clone?: { url: string; state: "running" | "failed"; error?: string };
}

export interface ProjectMemberRow {
  name: string;
  email?: string;
}

export interface ProjectSettingsData {
  file: string;
  members: ProjectMemberRow[];
  codeRepos: CodeRepoRow[];
  defaultCodeRepo: string | null;
  authorsInMarkdown: boolean;
  canEdit: boolean;
  canLink: boolean;
  canChooseFolder: boolean;
  /** Missing code repos can be cloned here (not in the demo, the read-only site or a hosted worker). */
  canClone?: boolean;
}

/**
 * Ask for the url to clone a missing code repo from — the app's suggestion
 * filled in — and start the clone (specs/app/project-settings.feature.md "A
 * code repo that is not on this computer is offered for cloning"). Answers
 * the page's data with the clone running, null when the user said no, or
 * the server's refusal.
 */
export async function askToCloneCodeRepo(
  prompt: (opts: PromptOptions) => Promise<string | null>,
  repo: Pick<CodeRepoRow, "path" | "dir" | "cloneUrl" | "clone">,
  opts: { intro?: string } = {},
): Promise<{ data: ProjectSettingsData } | { error: string } | null> {
  const url = await prompt({
    title: `Clone ${repo.path}`,
    hint: `${opts.intro ? `${opts.intro} ` : ""}It is cloned into ${repo.dir}.`,
    initial: repo.clone?.url ?? repo.cloneUrl ?? "",
    placeholder: "https://github.com/acme/acme-app",
    confirmLabel: "Clone",
  });
  if (!url?.trim()) return null;
  const res = await fetch("/api/project-settings/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeRepo: repo.path, url: url.trim() }),
  }).catch(() => null);
  if (!res) return { error: "Could not start the clone" };
  const body = (await res.json().catch(() => ({}))) as Partial<ProjectSettingsData> & { error?: string };
  if (!res.ok) return { error: body.error ?? "Could not start the clone" };
  return { data: body as ProjectSettingsData };
}

/** The code repos a freshly opened data folder should offer to clone: missing, not already cloning. */
export function codeReposToOffer(data: ProjectSettingsData): CodeRepoRow[] {
  if (!data.canClone) return [];
  return data.codeRepos
    .filter((r) => !r.exists && r.clone?.state !== "running")
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

export interface ProjectSettingsPageProps {
  prompt(opts: PromptOptions): Promise<string | null>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** The native folder chooser, titled for a code repo; absent hides Browse…. */
  browseFolder?: () => Promise<string | null>;
  /** After a save: the app re-reads the listing, so the agent pane and the Assigned dropdown follow. */
  onChanged?: () => void;
  onClose: () => void;
  /** Tests: start from this instead of fetching. */
  initial?: ProjectSettingsData;
}

/**
 * A typed code repo path as the file should hold it: a bare folder name is
 * a sibling of the data repo (`acme-app` → `../acme-app`), the layout the
 * app assumes; anything with a slash, or absolute, is kept as typed (the
 * server stores a sibling's absolute path relative too).
 */
export function codeRepoPathTyped(input: string): string {
  const clean = input.trim().replace(/[\\/]+$/, "");
  if (!clean) return "";
  if (clean.startsWith("/") || clean.startsWith("~") || /^[A-Za-z]:/.test(clean)) return clean;
  if (clean === "." || clean === "..") return clean;
  if (clean.includes("/") || clean.includes("\\")) return clean;
  return `../${clean}`;
}

/** A typed member: `Ada Lovelace <ada@acme.example>`, or just the name. */
export function memberTyped(input: string): ProjectMemberRow | null {
  const m = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(input);
  if (m) {
    const name = m[1]!.trim();
    return name ? { name, email: m[2]! } : null;
  }
  const name = input.trim();
  return name ? { name } : null;
}

/** What the row says about a repo's `specs` entry. */
export function specsLinkLabel(link: CodeRepoRow["specsLink"], exists: boolean): string {
  if (!exists) return "";
  switch (link.state) {
    case "linked":
      return `specs → ${link.target ?? "this data folder"}`;
    case "elsewhere":
      return `specs → ${link.target ?? "elsewhere"} (not this data folder)`;
    case "folder":
      return "specs is a real folder here, not a symlink";
    default:
      return "no specs symlink";
  }
}

const SECTIONS = [
  { id: "project-code-repos", title: "Code repositories" },
  { id: "project-members", title: "Members" },
  { id: "project-feature-files", title: "Feature files" },
];

export function ProjectSettingsPage(props: ProjectSettingsPageProps) {
  const [data, setData] = useState<ProjectSettingsData | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    async (res: Response): Promise<boolean> => {
      const body = (await res.json().catch(() => ({}))) as Partial<ProjectSettingsData> & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not save the project settings");
        return false;
      }
      setData(body as ProjectSettingsData);
      setError(null);
      props.onChanged?.();
      return true;
    },
    [props.onChanged],
  );

  useEffect(() => {
    if (props.initial) return;
    let gone = false;
    void (async () => {
      const res = await fetch("/api/project-settings").catch(() => null);
      if (gone) return;
      if (!res) {
        setError("Could not read the project settings");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Partial<ProjectSettingsData> & { error?: string };
      if (!res.ok) setError(body.error ?? "Could not read the project settings");
      else setData(body as ProjectSettingsData);
    })();
    return () => {
      gone = true;
    };
  }, [props.initial]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/project-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return apply(res);
    } finally {
      setBusy(false);
    }
  };

  const link = async (repo: CodeRepoRow, action: "create" | "remove") => {
    setBusy(true);
    try {
      const res = await fetch("/api/project-settings/specs-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeRepo: repo.path, action }),
      });
      return apply(res);
    } finally {
      setBusy(false);
    }
  };

  // A clone runs in the background: poll until no row is cloning, then let
  // the app re-read its listing so the agent pane and Issues tab follow.
  const cloning = (data?.codeRepos ?? []).some((r) => r.clone?.state === "running");
  useEffect(() => {
    if (!cloning) return;
    const id = setInterval(() => {
      void (async () => {
        const res = await fetch("/api/project-settings").catch(() => null);
        if (!res?.ok) return;
        const body = (await res.json().catch(() => null)) as ProjectSettingsData | null;
        if (!body) return;
        setData(body);
        if (!body.codeRepos.some((r) => r.clone?.state === "running")) props.onChanged?.();
      })();
    }, 1500);
    return () => clearInterval(id);
  }, [cloning, props.onChanged]);

  const cloneRepo = async (repo: CodeRepoRow) => {
    setBusy(true);
    try {
      const result = await askToCloneCodeRepo(props.prompt, repo);
      if (!result) return;
      if ("error" in result) setError(result.error);
      else {
        setData(result.data);
        setError(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const repos = data?.codeRepos ?? [];
  const paths = repos.map((r) => r.path);
  const canEdit = data?.canEdit ?? false;
  const canLink = data?.canLink ?? false;

  const addRepo = async () => {
    const typed = await props.prompt({
      title: "Add a code repository",
      hint: "Relative to the data folder: a checkout beside it is ../name (a bare name is taken as one).",
      placeholder: "../acme-app",
      confirmLabel: "Add",
      browse: data?.canChooseFolder ? props.browseFolder : undefined,
    });
    const path = codeRepoPathTyped(typed ?? "");
    if (!path) return;
    await save({ codeRepos: [...paths, path] });
  };

  const removeRepo = async (repo: CodeRepoRow) => {
    const ok = await props.confirm({
      title: `Remove ${repo.path} from the project?`,
      body: "The folder and its specs symlink stay as they are; the project just stops naming it.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await save({ codeRepos: paths.filter((p) => p !== repo.path) });
  };

  const addMember = async () => {
    const typed = await props.prompt({
      title: "Add a member",
      hint: "A name, with the email in angle brackets if you like.",
      placeholder: "Ada Lovelace <ada@acme.example>",
      confirmLabel: "Add",
    });
    const member = memberTyped(typed ?? "");
    if (!member) return;
    await save({ members: [...(data?.members ?? []), member] });
  };

  return (
    <AppPageLayout title="Project settings" sections={SECTIONS} onClose={props.onClose} className="project-settings">
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {data && !data.canEdit && (
        <p className="settings-row-hint">These settings are read-only here.</p>
      )}
      <PageSection
        id="project-code-repos"
        title="Code repositories"
        hint={
          <>
            Where the code that implements the specs lives. The default one is where a coding session runs, whose
            GitHub issues the Issues tab shows, and where test links resolve. Each repo can hold a <code>specs</code>{" "}
            symlink to this data folder's spec tree, so the code sees the specs it implements.
          </>
        }
      >
        {repos.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row-label">
              <span>No code repository yet</span>
              <span className="settings-row-hint">Coding sessions run in the data folder until one is added.</span>
            </span>
          </div>
        ) : (
          repos.map((repo) => (
            <div className="settings-row code-repo-row" key={repo.path} data-testid="code-repo-row">
              <span className="settings-row-label">
                <span className="code-repo-path">
                  <code title={repo.dir}>{repo.path}</code>
                  {repo.isDefault && <span className="code-repo-badge">default</span>}
                  {!repo.exists && <span className="code-repo-badge missing">not found</span>}
                </span>
                <span className="settings-row-hint" title={repo.dir}>
                  {repo.dir}
                </span>
                {!repo.exists && (
                  <span className="settings-row-hint code-repo-link" data-testid="code-repo-clone">
                    {repo.clone?.state === "running" ? (
                      <span>Cloning from {repo.clone.url}…</span>
                    ) : (
                      <>
                        <span className={repo.clone?.state === "failed" ? "code-repo-clone-error" : undefined}>
                          {repo.clone?.state === "failed"
                            ? repo.clone.error ?? "The clone failed"
                            : "Not on this computer"}
                        </span>
                        {data?.canClone && (
                          <button
                            type="button"
                            className="link"
                            disabled={busy}
                            aria-label={`Clone ${repo.path}`}
                            onClick={() => void cloneRepo(repo)}
                          >
                            {repo.clone?.state === "failed" ? "Try again…" : "Clone…"}
                          </button>
                        )}
                      </>
                    )}
                  </span>
                )}
                {repo.exists && (
                  <span className="settings-row-hint code-repo-link">
                    <span>{specsLinkLabel(repo.specsLink, repo.exists)}</span>
                    {canLink && repo.specsLink.state === "missing" && (
                      <button
                        type="button"
                        className="link"
                        disabled={busy}
                        aria-label={`Create the specs symlink in ${repo.path}`}
                        onClick={() => void link(repo, "create")}
                      >
                        Create symlink
                      </button>
                    )}
                    {canLink && (repo.specsLink.state === "linked" || repo.specsLink.state === "elsewhere") && (
                      <button
                        type="button"
                        className="link"
                        disabled={busy}
                        aria-label={`Remove the specs symlink from ${repo.path}`}
                        onClick={() => void link(repo, "remove")}
                      >
                        Remove symlink
                      </button>
                    )}
                  </span>
                )}
              </span>
              {canEdit && (
                <span className="code-repo-actions">
                  <label className="code-repo-default">
                    <input
                      type="radio"
                      name="default-code-repo"
                      checked={repo.isDefault}
                      disabled={busy}
                      aria-label={`Make ${repo.path} the default code repo`}
                      onChange={() => void save({ defaultCodeRepo: repo.path })}
                    />
                    Default
                  </label>
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    aria-label={`Remove ${repo.path}`}
                    onClick={() => void removeRepo(repo)}
                  >
                    Remove
                  </button>
                </span>
              )}
            </div>
          ))
        )}
        {canEdit && (
          <div className="settings-row">
            <span className="settings-row-label">
              <span className="settings-row-hint">A checkout beside the data folder is the layout the app assumes.</span>
            </span>
            <button type="button" className="link" disabled={busy} onClick={() => void addRepo()}>
              Add repository…
            </button>
          </div>
        )}
      </PageSection>
      <PageSection
        id="project-members"
        title="Members"
        hint="The people working on the project — the names a feature's Assigned field offers."
      >
        {(data?.members ?? []).length === 0 ? (
          <div className="settings-row">
            <span className="settings-row-label">
              <span>Nobody listed yet</span>
            </span>
          </div>
        ) : (
          (data?.members ?? []).map((member) => (
            <div className="settings-row" key={member.name} data-testid="member-row">
              <span className="settings-row-label">
                <span>{member.name}</span>
                {member.email && <span className="settings-row-hint">{member.email}</span>}
              </span>
              {canEdit && (
                <span className="code-repo-actions">
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    aria-label={`Remove ${member.name}`}
                    onClick={() =>
                      void save({ members: (data?.members ?? []).filter((m) => m.name !== member.name) })
                    }
                  >
                    Remove
                  </button>
                </span>
              )}
            </div>
          ))
        )}
        {canEdit && (
          <div className="settings-row">
            <span className="settings-row-label" />
            <button type="button" className="link" disabled={busy} onClick={() => void addMember()}>
              Add member…
            </button>
          </div>
        )}
      </PageSection>
      <PageSection id="project-feature-files" title="Feature files">
        <div className="settings-row">
          <span className="settings-row-label">
            <span>Authors in the markdown</span>
            <span className="settings-row-hint">
              Write who created and last updated each feature and scenario into the .feature.md files.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Authors in the markdown"
              checked={data?.authorsInMarkdown ?? false}
              disabled={busy || !data}
              onChange={(e) => void save({ authorsInMarkdown: e.target.checked })}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </div>
        {data && (
          <p className="settings-row-hint">
            Stored in <code>{data.file}</code>, checked into the data folder and pushed with the next sync.
          </p>
        )}
      </PageSection>
    </AppPageLayout>
  );
}
