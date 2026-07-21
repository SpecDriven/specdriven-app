import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import {
  isTestLink,
  parseFeature,
  serializeFeature,
  sortScenarios,
  titleFromFileName,
} from "../server/parser";
import type { Feature, Scenario } from "../server/parser";
import type { FeatureListing } from "../server/features";
import type { CurrentUser } from "../server/user";
import { Logo } from "./Logo";
import { MarkdownEditor } from "./MarkdownEditor";
import { renderMarkdown } from "./markdown";
import { ScenarioTable } from "./ScenarioTable";
import { featurePath, parseRoute, resolveScenario, scenarioPath } from "./route";
import { buildTree } from "./tree";
import type { FolderNode } from "./tree";
import { useFocusTrap } from "./useFocusTrap";
import type { ScenarioRef } from "./route";

interface Conflict {
  ours: string;
  theirs: string;
  message: string;
  /** Set when the conflicted publish targeted a single scenario. */
  scenario?: { name: string; version: number };
}

/** index === null means a new scenario being added. */
interface EditState {
  index: number | null;
  scenario: Scenario;
}

interface OpenOptions {
  /** Push a history entry for the opened feature (deliberate navigation). */
  push?: boolean;
  /**
   * Deep-link target (specs/navigation.spec.md): select this scenario, or
   * clear the selection when null. Undefined keeps the same-file selection
   * preservation used by sync/cron refreshes.
   */
  scenario?: ScenarioRef | null;
}

export function App() {
  const [dataRepo, setDataRepo] = useState<string | null>(null);
  const [needsRepo, setNeedsRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [settingRepo, setSettingRepo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<FeatureListing[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  /** Folder paths whose subtree is collapsed in the sidebar. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Folder highlighted by a click; "+ New folder" creates inside it. */
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  /** File name of the feature being dragged, if any. */
  const [dragging, setDragging] = useState<string | null>(null);
  /** Sidebar entry whose "⋯" menu is open (file name), if any. */
  const [treeMenu, setTreeMenu] = useState<string | null>(null);
  /** True while the File submenu of the open tree menu is expanded. */
  const [treeMenuFile, setTreeMenuFile] = useState(false);
  /** Folder path the drag is hovering over ("" = top level). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [feature, setFeature] = useState<Feature | null>(null);
  /** Draft for the inline file-name editor; null while not editing. */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<number | null>(null);
  const scenarioRefs = useRef<(HTMLElement | null)[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [conflictDraft, setConflictDraft] = useState("");
  const [status, setStatus] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [syncing, setSyncing] = useState(false);
  /** "all", a scenario key (`name@vN`), or null while no publish is running. */
  const [publishing, setPublishing] = useState<string | null>(null);
  const [reloadSeconds, setReloadSeconds] = useState(60);
  const [previewLines, setPreviewLines] = useState(8);
  // Test links (specs/traceability.spec.md): the table of automated-test
  // links at the end of each scenario card is optional; default ON.
  const [showTestLinks, setShowTestLinks] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState("60");
  const [settingsLinesDraft, setSettingsLinesDraft] = useState("8");
  const [settingsTestLinksDraft, setSettingsTestLinksDraft] = useState(true);
  /** Url being typed into the edit dialog's "Add test link" field. */
  const [testDraft, setTestDraft] = useState("");
  // Git scheme (specs/git-operations.spec.md): how git authenticates to
  // GitHub. null = auto-discover by probing (https, ssh, gh); the detected
  // value is what probing landed on.
  const [gitScheme, setGitScheme] = useState<string | null>(null);
  const [gitSchemeDetected, setGitSchemeDetected] = useState<string | null>(null);
  const [settingsSchemeDraft, setSettingsSchemeDraft] = useState("auto");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** Path whose "Copy link" action just ran — its label shows "Copied". */
  const [copied, setCopied] = useState<string | null>(null);
  // Current user (specs/user-info-settings.spec.md): shown in the sidebar's
  // lower left corner; the chip opens a menu with User info and Settings.
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userInfoOpen, setUserInfoOpen] = useState(false);

  const loadFeatures = useCallback(async () => {
    const res = await fetch("/api/features");
    const data = await res.json();
    if (res.ok) {
      setFeatures(data.features);
      setFolders(data.folders ?? []);
      setLoadError(null);
    } else {
      setLoadError(data.error ?? "Could not load features");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const state = await (await fetch("/api/state")).json();
      setDataRepo(state.dataRepo);
      setNeedsRepo(state.needsDataRepo);
      if (typeof state.reloadFrequencySeconds === "number") {
        setReloadSeconds(state.reloadFrequencySeconds);
      }
      if (typeof state.scenarioPreviewLines === "number") {
        setPreviewLines(state.scenarioPreviewLines);
      }
      if (typeof state.showTestLinks === "boolean") {
        setShowTestLinks(state.showTestLinks);
      }
      setGitScheme(state.gitScheme ?? null);
      setGitSchemeDetected(state.gitSchemeDetected ?? null);
      if (state.user) setUser(state.user);
      if (!state.needsDataRepo) {
        await loadFeatures();
        // Deep link (specs/navigation.spec.md): the entry url picks the view.
        await openFromLocation();
      }
      setLoading(false);
    })();
  }, [loadFeatures]);

  // Mirror the server's cron reload (specs/crud-feature.spec.md): refresh the
  // feature list on the same cadence so pulled changes show up, without
  // clobbering an in-progress edit or conflict resolution.
  useEffect(() => {
    if (loading || needsRepo || reloadSeconds <= 0) return;
    const id = setInterval(() => {
      void loadFeatures();
      if (selected && !dirty && !editing && !conflict) void openFeature(selected);
    }, reloadSeconds * 1000);
    return () => clearInterval(id);
  }, [loading, needsRepo, reloadSeconds, selected, dirty, editing, conflict, loadFeatures]);

  // specs/ui.spec.md "Select scenarios via up and down keys": arrow keys move a
  // highlight through the scenario cards, Enter opens the highlighted one in
  // the dialog. Inert while a dialog is open or while typing in a field.
  useEffect(() => {
    if (!feature || feature.scenarios.length === 0 || editing || settingsOpen || userInfoOpen)
      return;
    const count = feature.scenarios.length;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // Steal focus from a clicked button (e.g. the feature just opened in
        // the sidebar) so a following Enter edits the highlighted scenario
        // instead of re-activating that button.
        if (t instanceof HTMLElement) t.blur();
        setSelectedScenario((i) => {
          if (e.key === "ArrowDown") return i === null ? 0 : Math.min(i + 1, count - 1);
          return i === null ? count - 1 : Math.max(i - 1, 0);
        });
      } else if (e.key === "Enter" && selectedScenario !== null) {
        // A focused button keeps its native Enter activation.
        if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement) return;
        const s = feature.scenarios[selectedScenario];
        if (s) setEditing({ index: selectedScenario, scenario: { ...s } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [feature, editing, settingsOpen, userInfoOpen, selectedScenario]);

  // The dialog's "Add test link" field starts empty each time it opens
  // (specs/traceability.spec.md).
  const editingOpen = editing !== null;
  useEffect(() => {
    setTestDraft("");
  }, [editingOpen]);

  // specs/ui.spec.md "Scenario edit dialog": ESC returns to the scenario
  // screen — same as Cancel/Close, and it works while a dialog field has focus.
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  // specs/user-info-settings.spec.md: ESC or a click anywhere else closes
  // the user menu.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest(".user-corner"))
        setUserMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setUserMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenuOpen]);

  // specs/ui.spec.md "Feature entry menu": ESC or a click anywhere else
  // closes the entry's drop down menu (same behavior as the user menu).
  useEffect(() => {
    if (treeMenu === null) return;
    const close = () => {
      setTreeMenu(null);
      setTreeMenuFile(false);
    };
    const onDown = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest(".tree-row-menu")) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [treeMenu]);

  // specs/folders.spec.md: ESC deselects the folder, moving the insertion
  // point back to the tree root so "+ New folder" adds a top-level folder.
  // Inert while a dialog is open or while typing (ESC cancels those instead).
  useEffect(() => {
    if (
      selectedFolder === null ||
      editing ||
      settingsOpen ||
      userMenuOpen ||
      userInfoOpen ||
      treeMenu !== null
    )
      return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      e.preventDefault();
      setSelectedFolder(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedFolder, editing, settingsOpen, userMenuOpen, userInfoOpen, treeMenu]);

  // specs/ui.spec.md "Dialogs": Tab stays inside the foreground dialog.
  const settingsTrapRef = useFocusTrap(settingsOpen);
  const editingTrapRef = useFocusTrap(editing !== null);
  const userInfoTrapRef = useFocusTrap(userInfoOpen);

  useEffect(() => {
    if (selectedScenario !== null)
      scenarioRefs.current[selectedScenario]?.scrollIntoView({ block: "nearest" });
  }, [selectedScenario]);

  // Canonical url (specs/navigation.spec.md "Resolution rules"): the address
  // bar always shows what is actually selected. replaceState so selection
  // moves don't spam history — deliberate feature switches push in openFeature.
  useEffect(() => {
    if (loading || needsRepo) return;
    const s = selectedScenario !== null ? feature?.scenarios[selectedScenario] : undefined;
    const url = selected ? (s ? scenarioPath(selected, s) : featurePath(selected)) : "/";
    if (location.pathname !== url) history.replaceState(null, "", url);
  }, [loading, needsRepo, selected, feature, selectedScenario]);

  // Window title follows the selection (specs/navigation.spec.md) — chat and
  // email link previews show it.
  useEffect(() => {
    const s =
      feature && selectedScenario !== null ? feature.scenarios[selectedScenario] : undefined;
    const name = feature && selected ? feature.name || titleFromFileName(selected) : "";
    document.title =
      !selected || !feature
        ? "SpecDriven"
        : s
          ? `SpecDriven — ${name} · ${s.name} v${s.version}`
          : `SpecDriven — ${name}`;
  }, [selected, feature, selectedScenario]);

  const saveRepo = async (repo: string) => {
    // Capture the entry url now: once needsRepo flips, the canonical-url
    // effect would rewrite a deep link before we get to honor it
    // (specs/navigation.spec.md "deep link before a data repo is configured").
    const entryPath = location.pathname;
    setSettingRepo(true);
    setRepoError(null);
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRepo: repo }),
      });
      const state = await res.json();
      if (res.ok) {
        setDataRepo(state.dataRepo);
        setNeedsRepo(false);
        await loadFeatures();
        await openFromLocation(entryPath);
      } else {
        setRepoError(state.error ?? "Could not use this repo");
      }
    } finally {
      setSettingRepo(false);
    }
  };

  const openFeature = async (file: string, opts: OpenOptions = {}) => {
    const res = await fetch(`/api/features/${encodeURIComponent(file)}`);
    if (res.ok) {
      const data = await res.json();
      const parsed = parseFeature(data.content);
      setSelected(file);
      setFeature(parsed);
      let missingScenario: string | null = null;
      if (opts.scenario !== undefined) {
        // Deep link (specs/navigation.spec.md): resolve slug (+ version) to a
        // card; a miss opens the feature with no selection and a note.
        const idx = opts.scenario === null ? null : resolveScenario(parsed.scenarios, opts.scenario);
        if (opts.scenario !== null && idx === null) missingScenario = opts.scenario.slug;
        setSelectedScenario(idx);
      } else {
        // Keep the keyboard highlight across a same-file refresh (sync, cron);
        // drop it when switching files or when the list shrank past it.
        setSelectedScenario((prev) =>
          file === selected && prev !== null && prev < parsed.scenarios.length ? prev : null,
        );
      }
      if (opts.push && location.pathname !== featurePath(file)) {
        history.pushState(null, "", featurePath(file));
      }
      setDirty(false);
      setEditing(null);
      setRenameDraft(null);
      setConflict(null);
      setStatus(
        missingScenario
          ? `Scenario "${missingScenario}" not found — it may have been renamed or deleted.`
          : "",
      );
    } else {
      // The file is gone — deleted, renamed by the `.feature.md` migration, or
      // a stale deep link. Drop a stale selection rather than re-fetching it
      // on every reload tick; a link or click that misses leaves a note.
      if (file === selected) {
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
        setStatus("");
      }
      if (opts.push || opts.scenario !== undefined) {
        setStatus(`Feature "${file}" not found — the link may be stale.`);
      }
      await loadFeatures();
    }
  };

  /** Derive the view from a url (initial load, popstate, after repo setup). */
  const openFromLocation = async (pathname = location.pathname) => {
    const route = parseRoute(pathname);
    if (route.feature) {
      await openFeature(route.feature, { scenario: route.scenario ?? null });
    } else {
      setSelected(null);
      setFeature(null);
      setSelectedScenario(null);
      setStatus("");
    }
  };

  // Back/forward (specs/navigation.spec.md "browser history and reload"):
  // re-derive the view from the url. The ref keeps the handler current
  // without re-registering listeners on every state change.
  const openFromLocationRef = useRef(openFromLocation);
  openFromLocationRef.current = openFromLocation;
  useEffect(() => {
    const onPop = () => void openFromLocationRef.current();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const createFeature = async () => {
    const name = window.prompt("Feature name (use folder/name to create inside a folder):");
    if (!name) return;
    const res = await fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok) {
      await loadFeatures();
      await openFeature(data.fileName, { push: true });
    } else {
      setStatus(data.error);
    }
  };

  // Folders (specs/folders.spec.md): plain directories in the data repo.
  // With a folder selected, the new folder is created inside it.
  const createFolder = async () => {
    const parent = selectedFolder;
    const input = window.prompt(
      parent ? `Folder name (inside "${parent}"):` : "Folder name (use / for nesting):",
    );
    if (!input) return;
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parent ? `${parent}/${input}` : input }),
    });
    const data = await res.json();
    if (res.ok) {
      // Reveal and select the new folder, so a follow-up "+ New folder"
      // nests inside it and a drag has a visible target.
      if (parent) setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parent);
        return next;
      });
      setSelectedFolder(data.path);
      await loadFeatures();
    } else {
      setStatus(data.error ?? "Could not create the folder");
    }
  };

  // Only empty folders can be deleted (specs/folders.spec.md) — the
  // server refuses otherwise, and the refusal lands in the status line.
  const removeFolder = async (path: string) => {
    if (!window.confirm(`Delete folder "${path}"?`)) return;
    const res = await fetch(`/api/folders/${encodeURIComponent(path)}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      // A selection under the deleted folder points nowhere — drop it.
      setSelectedFolder((f) => (f === path || f?.startsWith(`${path}/`) ? null : f));
      await loadFeatures();
    } else {
      setStatus(data.error ?? "Could not delete the folder");
    }
  };

  // Drag-move (specs/folders.spec.md): the server does a `git mv` into
  // the target folder, committed and pushed. A selected feature stays
  // selected under its new path — the canonical-url effect follows along.
  const moveTo = async (fileName: string, folder: string) => {
    setDragging(null);
    setDropTarget(null);
    const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    const data = await res.json();
    if (res.ok) {
      await loadFeatures();
      if (data.fileName !== fileName) {
        if (selected === fileName) await openFeature(data.fileName);
        setStatus(`Moved to ${folder || "the top level"} — ${data.message}.`);
      }
    } else {
      setStatus(data.error ?? "Move failed");
    }
  };

  // specs/ui.spec.md "Main page": the Edit link next to the feature name lets
  // the user edit the feature name — the file's `# <name>` heading. The server
  // rewrites the heading, commits and pushes; the file name (and so the
  // feature's url) stays the same.
  const renameSelected = async () => {
    if (!selected || renameDraft === null) return;
    const target = renameDraft.trim();
    const currentName = feature ? feature.name || titleFromFileName(selected) : "";
    if (!target || target === currentName) {
      setRenameDraft(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: target }),
      });
      const data = await res.json();
      if (res.ok) {
        setRenameDraft(null);
        await loadFeatures();
        await openFeature(selected);
        setStatus(`Renamed to "${data.name}" — ${data.message}.`);
      } else {
        setStatus(data.error ?? "Rename failed");
      }
    } catch {
      setStatus("Rename failed — is the server running?");
    } finally {
      setRenaming(false);
    }
  };

  /** The file name shown in the menu: only the part left of the dot —
      the `.feature.md` extension is hidden (specs/ui.spec.md "Feature
      entry menu"). */
  const fileStem = (fileName: string) => fileName.split("/").pop()!.split(".")[0]!;

  // File → Rename (specs/ui.spec.md "Feature entry menu"): renames the
  // underlying file. The extension stays; a selected feature follows its
  // new file name (and so a new url — old links go stale).
  const renameFile = async (fileName: string) => {
    const stem = window.prompt(
      "File name (the .feature.md extension is kept):",
      fileStem(fileName),
    );
    if (!stem || stem.trim() === fileStem(fileName)) return;
    const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/rename-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stem }),
    });
    const data = await res.json();
    if (res.ok) {
      await loadFeatures();
      if (data.fileName !== fileName) {
        if (selected === fileName) await openFeature(data.fileName);
        setStatus(`Renamed file to ${fileStem(data.fileName)} — ${data.message}.`);
      }
    } else {
      setStatus(data.error ?? "Rename failed");
    }
  };

  // Delete (specs/ui.spec.md "Feature entry menu"): removes the feature file
  // after a confirmation — a `git rm`, committed and pushed on the server.
  const removeFeature = async (f: FeatureListing) => {
    if (!window.confirm(`Delete feature "${f.name}" (${f.fileName})?`)) return;
    const res = await fetch(`/api/features/${encodeURIComponent(f.fileName)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (res.ok) {
      if (selected === f.fileName) {
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
      }
      await loadFeatures();
      setStatus(`Deleted "${f.name}" — ${data.message}.`);
    } else {
      setStatus(data.error ?? "Delete failed");
    }
  };

  const scenarioKey = (s: { name: string; version: number }) => `${s.name}@v${s.version}`;

  // Publish buttons (specs/ui.spec.md "Main page"): same style and behavior as
  // Sync — disabled with a progress label while running, no "Published" status
  // line at the bottom of the page. Without a target every scenario is
  // published (the upper-left "Publish All"); with one, only that scenario
  // (specs/crud-feature.spec.md "publish each scenario individually").
  const publish = async (scenario?: { name: string; version: number }) => {
    if (!selected || !feature) return;
    setPublishing(scenario ? scenarioKey(scenario) : "all");
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(feature), scenario }),
      });
      const data = await res.json();
      if (res.status === 409 && data.status === "conflict") {
        setConflict({ ours: data.ours, theirs: data.theirs, message: data.message, scenario });
        setConflictDraft(data.ours);
        setStatus("Merge conflict — choose a resolution below.");
      } else if (res.ok) {
        await openFeature(selected);
      } else {
        setStatus(data.error ?? "Publish failed");
      }
    } catch {
      setStatus("Publish failed — is the server running?");
    } finally {
      setPublishing(null);
    }
  };

  // Sync button (specs/ui.spec.md "Main page"): immediate data reload — the
  // server runs one reload tick (pull + push saved), then the view refreshes.
  // Like the cron mirror above, an in-progress edit or conflict is not clobbered.
  // Progress shows only on the button — no status line at the bottom of the page.
  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/reload", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.error ?? "Sync failed");
        return;
      }
      await loadFeatures();
      if (selected && !dirty && !editing && !conflict) await openFeature(selected);
    } catch {
      setStatus("Sync failed — is the server running?");
    } finally {
      setSyncing(false);
    }
  };

  const resolveWith = async (resolved: string) => {
    if (!selected) return;
    setStatus("Publishing resolution…");
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: resolved,
        resolveConflict: true,
        // Keep an individual publish scoped to its scenario through the
        // conflict resolution.
        scenario: conflict?.scenario,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      await openFeature(selected);
    } else {
      setStatus(data.error ?? "Publish failed");
    }
  };

  /** Handle a link in-app on a plain click; cmd/ctrl/shift-clicks keep their
      native behavior (new tab etc — specs/navigation.spec.md "share a link"). */
  const spaClick = (e: MouseEvent, go: () => void) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };

  // "Copy link" (specs/navigation.spec.md "share a link"): absolute url on
  // the clipboard; the pressed control's label flips to "Copied" for 2 sec.
  const copyLink = async (path: string) => {
    const url = location.origin + path;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // navigator.clipboard needs a secure context and permission — absent
      // e.g. on a plain-http LAN host. Fall back to a selection-based copy.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) {
        setStatus("Could not copy the link to the clipboard.");
        return;
      }
    }
    setCopied(path);
    window.setTimeout(() => setCopied((p) => (p === path ? null : p)), 2000);
  };

  // specs/crud-feature.spec.md ("Scenario is automatically saved locally and
  // pushed to GitHub"): show 'Saved' on the top banner for 2 sec.
  const flashSaved = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2000);
  };

  /**
   * The version a scenario gets is derived, never typed (specs/ui.spec.md):
   * one past the highest version already carrying that name, or 1 when the
   * name is new. Editing an existing entry keeps the version it was given.
   */
  const nextVersionFor = (name: string) => {
    const versions = (feature?.scenarios ?? [])
      .filter((s) => s.name.trim() === name.trim())
      .map((s) => s.version);
    return versions.length ? Math.max(...versions) + 1 : 1;
  };

  /** The version the open dialog will save under; shown read-only in the dialog. */
  const draftVersion = !editing
    ? 1
    : editing.index === null
      ? nextVersionFor(editing.scenario.name)
      : editing.scenario.version;

  /**
   * Saving the dialog auto-saves the whole feature locally (marked
   * [proposed], so no data is lost); the server's reload cron commits and
   * pushes it.
   */
  const saveScenario = async () => {
    if (!editing || !feature || !selected) return;
    const s = { ...editing.scenario, version: draftVersion };
    const next: Feature = {
      ...feature,
      scenarios: sortScenarios(
        editing.index === null
          ? [...feature.scenarios, s]
          : feature.scenarios.map((sc, i) => (i === editing.index ? s : sc)),
      ),
    };
    setFeature(next);
    setEditing(null);
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: serializeFeature(next), save: true }),
    });
    const data = await res.json();
    if (res.ok) {
      setFeature(parseFeature(data.content));
      setDirty(false);
      setStatus("Saved — publish scenarios from their cards, or press Publish All.");
      flashSaved();
    } else {
      setDirty(true);
      setStatus(data.error ?? "Save failed");
    }
  };

  // Avatar initials: from the git name when set, else the OS user name
  // (specs/user-info-settings.spec.md).
  const initials = (user?.name || user?.username || "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const openSettings = () => {
    setSettingsDraft(String(reloadSeconds));
    setSettingsLinesDraft(String(previewLines));
    setSettingsSchemeDraft(gitScheme ?? "auto");
    setSettingsTestLinksDraft(showTestLinks);
    setSettingsError(null);
    setSettingsOpen(true);
  };

  // Settings are saved to the settings file (specs/ui.spec.md).
  const saveSettings = async () => {
    const n = Number(settingsDraft);
    if (!Number.isFinite(n) || n < 0) {
      setSettingsError("Enter a number of seconds (0 disables automatic reload).");
      return;
    }
    const lines = Number(settingsLinesDraft);
    if (!Number.isFinite(lines) || lines < 1) {
      setSettingsError("Enter how many preview lines to show per scenario (at least 1).");
      return;
    }
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reloadFrequencySeconds: Math.floor(n),
        scenarioPreviewLines: Math.floor(lines),
        gitScheme: settingsSchemeDraft,
        showTestLinks: settingsTestLinksDraft,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setReloadSeconds(data.reloadFrequencySeconds);
      setPreviewLines(data.scenarioPreviewLines);
      setShowTestLinks(data.showTestLinks !== false);
      setGitScheme(data.gitScheme ?? null);
      setGitSchemeDetected(data.gitSchemeDetected ?? null);
      setSettingsOpen(false);
    } else {
      setSettingsError(data.error ?? "Could not save settings");
    }
  };

  // Test links (specs/traceability.spec.md): shown as the link's path within
  // GitHub — the `https://github.com/` prefix carries no information.
  const testLinkLabel = (url: string) => url.replace(/^https:\/\/(www\.)?github\.com\//, "");

  const addTestLink = () => {
    if (!editing) return;
    const url = testDraft.trim();
    if (!isTestLink(url) || editing.scenario.tests.includes(url)) return;
    setEditing({
      ...editing,
      scenario: { ...editing.scenario, tests: [...editing.scenario.tests, url] },
    });
    setTestDraft("");
  };

  const removeTestLink = (url: string) => {
    if (!editing) return;
    setEditing({
      ...editing,
      scenario: {
        ...editing.scenario,
        tests: editing.scenario.tests.filter((t) => t !== url),
      },
    });
  };

  /** The clickable test-links table at the end of a scenario
      (specs/traceability.spec.md). */
  const testsTable = (tests: string[]) =>
    tests.length > 0 && (
      <table className="scenario-tests">
        <thead>
          <tr>
            <th>Automated tests</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => (
            <tr key={t}>
              <td>
                <a href={t} target="_blank" rel="noreferrer" title={t}>
                  {testLinkLabel(t)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  /**
   * Delete a [proposed] scenario from the dialog (specs/ui.spec.md "Scenario
   * edit dialog"), after a confirmation. The removal is saved like any edit —
   * auto-saved locally; the reload cron commits and pushes it.
   */
  const deleteScenario = async () => {
    if (!editing || editing.index === null || !feature || !selected) return;
    const idx = editing.index;
    const { name, version } = editing.scenario;
    if (!window.confirm(`Delete scenario "${name}" v${version}?`)) return;
    const next: Feature = {
      ...feature,
      scenarios: feature.scenarios.filter((_, i) => i !== idx),
    };
    setFeature(next);
    setEditing(null);
    // The keyboard highlight can't stay on the removed card; later cards
    // shift up one index.
    setSelectedScenario((prev) =>
      prev === null || prev === idx ? null : prev > idx ? prev - 1 : prev,
    );
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: serializeFeature(next), save: true }),
    });
    const data = await res.json();
    if (res.ok) {
      setFeature(parseFeature(data.content));
      setDirty(false);
      setStatus(`Deleted scenario "${name}" v${version}.`);
      flashSaved();
    } else {
      setDirty(true);
      setStatus(data.error ?? "Delete failed");
    }
  };

  /** Draft the next version of a published scenario as a new, editable scenario. */
  const newVersion = (i: number) => {
    if (!feature) return;
    const src = feature.scenarios[i]!;
    setEditing({
      index: null,
      // index null marks it as new, so the version is derived on save.
      scenario: { ...src, version: nextVersionFor(src.name), published: false, proposed: false },
    });
  };

  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** One sidebar entry per feature; the entry is the drag source. */
  const featureItem = (f: FeatureListing, depth: number) => (
    <div key={f.fileName} className="tree-row">
      {/* A real link (specs/navigation.spec.md "share a link"): plain clicks
          navigate in-app, right-click → Copy Link works. The label is the
          feature name, not the file name (specs/ui.spec.md "Main page"). */}
      <a
        href={featurePath(f.fileName)}
        className={`tree-feature${f.fileName === selected ? " active" : ""}`}
        style={{ paddingLeft: `${0.6 + depth * 0.9}rem` }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", f.fileName);
          e.dataTransfer.effectAllowed = "move";
          setDragging(f.fileName);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropTarget(null);
        }}
        onClick={(e) =>
          spaClick(e, () => {
            // Opening a feature is a deliberate move away from the folder.
            setSelectedFolder(null);
            void openFeature(f.fileName, { push: true });
          })
        }
      >
        {f.name}
      </a>
      {/* Drop down menu (specs/ui.spec.md "Feature entry menu"): File →
          Rename edits the underlying file name; Delete removes the file. */}
      <span className="tree-row-menu">
        <button
          type="button"
          className="tree-menu-btn"
          title={`Menu for ${f.fileName}`}
          aria-haspopup="menu"
          aria-expanded={treeMenu === f.fileName}
          onClick={() => {
            setTreeMenuFile(false);
            setTreeMenu((m) => (m === f.fileName ? null : f.fileName));
          }}
        >
          ⋯
        </button>
        {treeMenu === f.fileName && (
          <div className="tree-menu" role="menu" aria-label={`Menu for ${f.fileName}`}>
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={treeMenuFile}
              onClick={() => setTreeMenuFile((o) => !o)}
            >
              File {treeMenuFile ? "▾" : "▸"}
            </button>
            {treeMenuFile && (
              <div className="tree-submenu" role="menu" aria-label="File">
                <button
                  role="menuitem"
                  onClick={() => {
                    setTreeMenu(null);
                    setTreeMenuFile(false);
                    void renameFile(f.fileName);
                  }}
                >
                  Rename “{fileStem(f.fileName)}”
                </button>
              </div>
            )}
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setTreeMenu(null);
                setTreeMenuFile(false);
                void removeFeature(f);
              }}
            >
              Delete
            </button>
          </div>
        )}
      </span>
    </div>
  );

  /**
   * Folders then features, indented per depth (specs/folders.spec.md).
   * A folder's whole subtree is its drop zone — dropping on a feature drops
   * into the folder that holds it; nested folders win via stopPropagation.
   */
  const renderTree = (node: FolderNode, depth: number) => (
    <>
      {node.folders.map((child) => (
        <div
          key={child.path}
          onDragOver={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(child.path);
          }}
          onDragLeave={() => setDropTarget((t) => (t === child.path ? null : t))}
          onDrop={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            void moveTo(dragging, child.path);
          }}
        >
          <div
            className={`folder-row${dragging !== null && dropTarget === child.path ? " drop-target" : ""}${
              child.path === selectedFolder ? " selected" : ""
            }`}
            style={{ paddingLeft: `${depth * 0.9}rem` }}
          >
            {/* Clicking selects the folder (specs/folders.spec.md — "+ New
                folder" then creates inside it) and toggles its subtree. */}
            <button
              type="button"
              className="folder-toggle"
              aria-expanded={!collapsed.has(child.path)}
              onClick={() => {
                setSelectedFolder(child.path);
                toggleFolder(child.path);
              }}
            >
              <span className="twist">{collapsed.has(child.path) ? "▸" : "▾"}</span> {child.name}
            </button>
            <button
              type="button"
              className="folder-delete"
              title={`Delete folder ${child.path}`}
              onClick={() => void removeFolder(child.path)}
            >
              ✕
            </button>
          </div>
          {!collapsed.has(child.path) && renderTree(child, depth + 1)}
        </div>
      ))}
      {node.features.map((f) => featureItem(f, depth))}
    </>
  );

  if (loading) return <main className="centered">Loading…</main>;

  if (needsRepo) {
    return (
      <main className="centered">
        <form
          className="repo-prompt"
          onSubmit={(e) => {
            e.preventDefault();
            const input = new FormData(e.currentTarget).get("repo") as string;
            if (input.trim()) saveRepo(input.trim());
          }}
        >
          <h1>SpecDriven</h1>
          <p>No data repo configured yet. Enter the GitHub url of the data repo (or a local path):</p>
          <input name="repo" placeholder="https://github.com/SpecDriven/data-insurance" autoFocus />
          <button type="submit" disabled={settingRepo}>
            {settingRepo ? "Checking access…" : "Use this repo"}
          </button>
          {repoError && <p className="error">{repoError}</p>}
        </form>
      </main>
    );
  }

  const editingPublished = editing?.scenario.published ?? false;
  // Delete applies to [proposed] scenarios only (specs/ui.spec.md "Scenario
  // edit dialog") — not to published ones (immutable), and not to a new
  // draft that isn't part of the feature yet (index === null).
  const editingProposed =
    editing !== null &&
    editing.index !== null &&
    editing.scenario.proposed &&
    !editing.scenario.published;
  const hasProposed = feature?.scenarios.some((s) => s.proposed && !s.published) ?? false;

  return (
    <main className="layout">
      {savedFlash && <div className="saved-banner">Saved</div>}
      <aside>
        <header>
          <h1>
            <Logo />
          </h1>
          <span className="repo-name">{dataRepo}</span>
        </header>
        <div className="sidebar-actions">
          <button onClick={createFolder}>+ New folder</button>
          <button onClick={createFeature}>+ New feature</button>
        </div>
        {loadError && <p className="error">{loadError}</p>}
        {/* Folder tree (specs/folders.spec.md): folders are drop targets
            for drag-moving features; the tree background is the top level. */}
        <div
          className={`tree${dragging !== null && dropTarget === "" ? " drop-target" : ""}`}
          onClick={(e) => {
            // A click on the bare background deselects the folder, so the
            // next "+ New folder" creates at the top level again.
            if (e.target === e.currentTarget) setSelectedFolder(null);
          }}
          onDragOver={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget("");
          }}
          onDragLeave={() => setDropTarget((t) => (t === "" ? null : t))}
          onDrop={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            void moveTo(dragging, "");
          }}
        >
          {renderTree(buildTree(folders, features), 0)}
          {features.length === 0 && folders.length === 0 && (
            <p className="empty">No feature files yet</p>
          )}
        </div>
        {/* specs/user-info-settings.spec.md: the lower left corner shows the
            current user; its menu holds User info and Settings. */}
        <div className="user-corner">
          {userMenuOpen && (
            <div className="user-menu" role="menu" aria-label="User menu">
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  setUserInfoOpen(true);
                }}
              >
                User info
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  openSettings();
                }}
              >
                ⚙ Settings
              </button>
            </div>
          )}
          <button
            className="user-chip"
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={() => setUserMenuOpen((o) => !o)}
          >
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="user-name">{user?.username ?? "…"}</span>
          </button>
        </div>
      </aside>
      <section className="editor">
        {selected && feature ? (
          <>
            <div className="editor-bar">
              {/* specs/ui.spec.md "Main page": the top of the page shows
                  "Feature: <name>", not the file name. The Edit link edits
                  this feature name (the file's `# <name>` heading), committed
                  and pushed on the server; the file name never changes. */}
              <div className="feature-title">
                {renameDraft === null ? (
                  <>
                    <h2>Feature: {feature.name || titleFromFileName(selected)}</h2>
                    <button
                      className="link"
                      onClick={() =>
                        setRenameDraft(feature.name || titleFromFileName(selected))
                      }
                    >
                      Edit
                    </button>
                    <button className="link" onClick={() => copyLink(featurePath(selected))}>
                      {copied === featurePath(selected) ? "Copied" : "Copy link"}
                    </button>
                  </>
                ) : (
                  <form
                    className="rename-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void renameSelected();
                    }}
                  >
                    <input
                      className="rename-input"
                      value={renameDraft}
                      aria-label="Feature name"
                      autoFocus
                      spellCheck={false}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRenameDraft(null);
                      }}
                    />
                    <button
                      type="submit"
                      className="link"
                      disabled={renaming || !renameDraft.trim()}
                    >
                      {renaming ? "Renaming…" : "Save"}
                    </button>
                    <button type="button" className="link" onClick={() => setRenameDraft(null)}>
                      Cancel
                    </button>
                  </form>
                )}
              </div>
              <div className="editor-actions">
                <button className="secondary" onClick={syncNow} disabled={syncing}>
                  {syncing ? "Syncing…" : "Sync"}
                </button>
                {/* Publish All, right of Sync (specs/crud-feature.spec.md
                    "publish each scenario individually"): marks every scenario
                    published; individual scenarios publish from their cards. */}
                <button
                  className="secondary"
                  onClick={() => void publish()}
                  disabled={publishing !== null}
                >
                  {publishing === "all"
                    ? "Publishing…"
                    : dirty || hasProposed
                      ? "Publish All *"
                      : "Publish All"}
                </button>
              </div>
            </div>
            {feature.description && <pre className="feature-desc">{feature.description}</pre>}
            {/* specs/ui.spec.md "Scenario List": each card renders its body as
                a Markdown preview, clamped to n lines (n set in Settings). */}
            <div
              className="scenarios"
              style={{ "--preview-lines": previewLines } as CSSProperties}
            >
              {feature.scenarios.map((s, i) => (
                <article
                  key={i}
                  ref={(el) => {
                    scenarioRefs.current[i] = el;
                  }}
                  className={`scenario-card${s.published ? " published" : ""}${
                    i === selectedScenario ? " selected" : ""
                  }`}
                >
                  <header>
                    <span className="scenario-title">
                      {/* The title is the scenario's permalink
                          (specs/navigation.spec.md "share a link"). */}
                      <a
                        href={scenarioPath(selected, s)}
                        onClick={(e) => spaClick(e, () => setSelectedScenario(i))}
                      >
                        {s.name}
                      </a>{" "}
                      <span className="version">v{s.version}</span>
                      {s.published && <span className="badge">published</span>}
                      {!s.published && s.proposed && (
                        <span className="badge proposed">proposed</span>
                      )}
                    </span>
                    <span className="card-actions">
                      {/* Unpublished cards: Edit, Publish, Copy link — in that
                          order (specs/crud-feature.spec.md "publish each
                          scenario individually"). */}
                      {!s.published && (
                        <>
                          <button
                            className="link"
                            onClick={() => setEditing({ index: i, scenario: { ...s } })}
                          >
                            Edit
                          </button>
                          <button
                            className="link"
                            disabled={publishing !== null}
                            onClick={() => void publish({ name: s.name, version: s.version })}
                          >
                            {publishing === scenarioKey(s) ? "Publishing…" : "Publish"}
                          </button>
                        </>
                      )}
                      <button
                        className="link"
                        onClick={() => copyLink(scenarioPath(selected, s))}
                      >
                        {copied === scenarioPath(selected, s) ? "Copied" : "Copy link"}
                      </button>
                      {s.published && (
                        <>
                          <button className="link" onClick={() => newVersion(i)}>
                            New version
                          </button>
                          <button
                            className="link"
                            onClick={() => setEditing({ index: i, scenario: { ...s } })}
                          >
                            View
                          </button>
                        </>
                      )}
                    </span>
                  </header>
                  {s.body && (
                    <div className="md-preview scenario-body">{renderMarkdown(s.body)}</div>
                  )}
                  {/* specs/traceability.spec.md: links to the automated tests,
                      as a table at the end of the scenario. Optional — the
                      Settings toggle hides it (default ON). */}
                  {showTestLinks && testsTable(s.tests)}
                </article>
              ))}
              {feature.scenarios.length === 0 && <p className="empty">No scenarios yet.</p>}
            </div>
            <div>
              <button
                className="add-scenario"
                onClick={() =>
                  setEditing({
                    index: null,
                    scenario: {
                      name: "",
                      version: 1,
                      published: false,
                      proposed: false,
                      body: "",
                      tests: [],
                    },
                  })
                }
              >
                + Add scenario
              </button>
            </div>
            {status && <p className="status">{status}</p>}
            {conflict && (
              <div className="conflict">
                <h3>Merge conflict</h3>
                <div className="conflict-panes">
                  <div>
                    <h4>Yours</h4>
                    <pre>{conflict.ours}</pre>
                  </div>
                  <div>
                    <h4>Theirs</h4>
                    <pre>{conflict.theirs}</pre>
                  </div>
                </div>
                <textarea
                  className="conflict-draft"
                  value={conflictDraft}
                  onChange={(e) => setConflictDraft(e.target.value)}
                  spellCheck={false}
                />
                <div className="conflict-actions">
                  <button onClick={() => resolveWith(conflict.ours)}>Accept yours</button>
                  <button onClick={() => resolveWith(conflict.theirs)}>Accept theirs</button>
                  <button onClick={() => resolveWith(conflictDraft)}>Publish manual edit</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="empty">Select a feature file or create a new one.</p>
            {/* A stale deep link lands here with a note (specs/navigation.spec.md). */}
            {status && <p className="status">{status}</p>}
          </>
        )}
      </section>
      {settingsOpen && (
        <div className="dialog-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="dialog" ref={settingsTrapRef} onClick={(e) => e.stopPropagation()}>
            <h3>Settings</h3>
            <label>
              Data reload frequency (seconds)
              <input
                type="number"
                min={0}
                autoFocus
                value={settingsDraft}
                onChange={(e) => setSettingsDraft(e.target.value)}
              />
            </label>
            <p className="hint">
              The data repo is git-pulled automatically at this interval. Use 0 to disable
              automatic reload.
            </p>
            <label>
              Scenario preview lines
              <input
                type="number"
                min={1}
                value={settingsLinesDraft}
                onChange={(e) => setSettingsLinesDraft(e.target.value)}
              />
            </label>
            <p className="hint">
              How many lines of the rendered Markdown body each scenario shows in the list.
              Settings are saved to .specdriven/settings.json.
            </p>
            {/* specs/traceability.spec.md: the test-links table is optional,
                controlled here; default ON. */}
            <label className="check-label">
              <input
                type="checkbox"
                checked={settingsTestLinksDraft}
                onChange={(e) => setSettingsTestLinksDraft(e.target.checked)}
              />
              Show links to automated tests
            </label>
            <p className="hint">
              Each scenario ends with a table of GitHub links to its automated tests, when it
              has any.
            </p>
            {/* Git scheme (specs/git-operations.spec.md): https, ssh or gh;
                auto-discovery probes them in that order. */}
            <label>
              Git scheme
              <select
                value={settingsSchemeDraft}
                onChange={(e) => setSettingsSchemeDraft(e.target.value)}
              >
                <option value="auto">
                  Auto-discover
                  {gitScheme === null && gitSchemeDetected ? ` (using ${gitSchemeDetected})` : ""}
                </option>
                <option value="https">https</option>
                <option value="ssh">ssh</option>
                <option value="gh">gh (GitHub CLI)</option>
              </select>
            </label>
            <p className="hint">
              How git authenticates to GitHub for clone, pull and push. Auto-discover probes
              https, then ssh, then gh.
            </p>
            {settingsError && <p className="error">{settingsError}</p>}
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button onClick={saveSettings}>Save settings</button>
            </div>
          </div>
        </div>
      )}
      {userInfoOpen && (
        <div className="dialog-backdrop" onClick={() => setUserInfoOpen(false)}>
          <div className="dialog" ref={userInfoTrapRef} onClick={(e) => e.stopPropagation()}>
            <h3>User info</h3>
            <dl className="user-info">
              <dt>OS user</dt>
              <dd>{user?.username ?? "unknown"}</dd>
              <dt>Git name</dt>
              <dd>{user?.name ?? <span className="unset">not set</span>}</dd>
              <dt>Git email</dt>
              <dd>{user?.email ?? <span className="unset">not set</span>}</dd>
            </dl>
            <p className="hint">
              Commits to the data repo are authored with this git identity.
            </p>
            <div className="dialog-actions">
              <button autoFocus onClick={() => setUserInfoOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          {/* specs/ui.spec.md "Scenario edit dialog": the scenario name is the
              dialog title (an editable title unless published), the dialog is
              resizable, and the body is an embedded markdown editor. */}
          <div className="dialog scenario-dialog" ref={editingTrapRef} onClick={(e) => e.stopPropagation()}>
            {editingPublished ? (
              <h3 className="dialog-title">
                {editing.scenario.name} <span className="version">v{editing.scenario.version}</span>
                <span className="badge">published</span>
              </h3>
            ) : (
              <input
                className="dialog-title-input"
                value={editing.scenario.name}
                placeholder="Scenario name"
                aria-label="Scenario name"
                autoFocus
                onChange={(e) =>
                  setEditing({ ...editing, scenario: { ...editing.scenario, name: e.target.value } })
                }
              />
            )}
            {!editingPublished && (
              // The version is assigned by the app, never typed: a new scenario
              // takes the next version for its name (specs/ui.spec.md).
              <p className="version-field">
                Version <span className="version">v{draftVersion}</span>
              </p>
            )}
            <div className="body-field">
              <span className="field-label">Body</span>
              <MarkdownEditor
                value={editing.scenario.body}
                readOnly={editingPublished}
                placeholder="Describe the scenario in Markdown…"
                onChange={(body) =>
                  setEditing({ ...editing, scenario: { ...editing.scenario, body } })
                }
              />
            </div>
            {!editingPublished && (
              // specs/scenario-table.spec.md: structured view over the
              // markdown table stored in the body.
              <div className="table-field">
                <span className="field-label">Scenario table</span>
                <ScenarioTable
                  body={editing.scenario.body}
                  onChange={(body) =>
                    setEditing({ ...editing, scenario: { ...editing.scenario, body } })
                  }
                />
              </div>
            )}
            {/* specs/traceability.spec.md: GitHub links to the automated
                tests covering this scenario. Published scenarios are
                immutable — their links render read-only. Hidden entirely
                when the Settings toggle is off. */}
            {!showTestLinks ? null : editingPublished ? (
              testsTable(editing.scenario.tests)
            ) : (
              <div className="tests-field">
                <span className="field-label">Automated tests</span>
                {editing.scenario.tests.length > 0 && (
                  <ul className="test-list">
                    {editing.scenario.tests.map((t) => (
                      <li key={t}>
                        <a href={t} target="_blank" rel="noreferrer" title={t}>
                          {testLinkLabel(t)}
                        </a>
                        <button
                          type="button"
                          className="link"
                          title={`Remove ${t}`}
                          onClick={() => removeTestLink(t)}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="test-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addTestLink();
                  }}
                >
                  <input
                    value={testDraft}
                    placeholder="https://github.com/owner/repo/blob/main/…/MyTest.java"
                    aria-label="Test link (GitHub url)"
                    spellCheck={false}
                    onChange={(e) => setTestDraft(e.target.value)}
                  />
                  <button type="submit" className="link" disabled={!isTestLink(testDraft)}>
                    Add
                  </button>
                </form>
              </div>
            )}
            <div className="dialog-actions">
              {/* Proposed scenarios can be deleted (specs/ui.spec.md
                  "Scenario edit dialog") — confirmed, then saved like any
                  edit. Kept apart from Cancel/Save on the far left. */}
              {editingProposed && (
                <button className="danger" onClick={() => void deleteScenario()}>
                  Delete
                </button>
              )}
              <button className="secondary" onClick={() => setEditing(null)}>
                {editingPublished ? "Close" : "Cancel"}
              </button>
              {!editingPublished && (
                <button onClick={saveScenario} disabled={!editing.scenario.name.trim()}>
                  Save scenario
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
