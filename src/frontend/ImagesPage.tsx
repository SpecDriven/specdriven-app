// Images (specs/app/unused-images.feature.md): every image stored under
// `.images/` in the data repo (src/server/imageCleanup.ts), in its own
// editor-pane page opened from the user menu like Data. The Unreferenced tab
// shows the ones no feature, page or other file names any more — a pasted
// screenshot whose line was deleted, or one a markup save replaced — as
// thumbnails to pick and delete; the All tab browses every image with where
// it is used. A thumbnail opens the image beside the grid with its details.
// Deleting is a `git rm`, committed and pushed, and the server refuses one a
// file has taken up meanwhile.

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { AppPageLayout, PageSection } from "./AppPage";
import { formatBytes } from "./dataViewer";
import type { ConfirmOptions } from "./ModalPrompts";
import { featurePath } from "./route";
import { toast } from "./Toasts";
import { Tooltip } from "./Tooltip";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface StoredImage {
  name: string;
  path: string;
  bytes: number;
  referencedBy: string[];
}

type Tab = "unreferenced" | "all";

export const IMAGES_URL = "/api/images";

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where a referencing file opens: a feature at its url, anything else named as it lies. */
function fileLink(file: string) {
  return file.endsWith(".feature.md") ? (
    <a href={featurePath(file)}>{file}</a>
  ) : (
    <span>{file}</span>
  );
}

export interface ImagesPageProps {
  onClose(): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** The demo's data repo is shared: nothing is deleted from it. */
  demo?: boolean;
  /** Injected in tests; the window's fetch otherwise. */
  fetcher?: Fetcher;
}

export function ImagesPage({ onClose, confirm, demo, fetcher }: ImagesPageProps) {
  const doFetch: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const fetchRef = useRef(doFetch);
  fetchRef.current = doFetch;

  const [images, setImages] = useState<StoredImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("unreferenced");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchRef.current(IMAGES_URL);
      if (!res.ok) throw new Error(await errorOf(res));
      const body = (await res.json()) as { images: StoredImage[] };
      setImages(body.images);
      setError(null);
      // A selection or preview of an image that is gone, or used now, is dropped.
      const unreferenced = new Set(body.images.filter((i) => i.referencedBy.length === 0).map((i) => i.name));
      setSelected((s) => new Set([...s].filter((n) => unreferenced.has(n))));
      setOpen((o) => (o !== null && body.images.some((i) => i.name === o) ? o : null));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const all = images ?? [];
  const unreferenced = all.filter((i) => i.referencedBy.length === 0);
  const shown = tab === "unreferenced" ? unreferenced : all;
  const canDelete = !demo;

  const toggle = (name: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  /** Delete these images after the user confirms; the list reloads either way a refusal lands. */
  const deleteNames = async (names: string[]) => {
    if (names.length === 0 || deleting) return;
    const ok = await confirm({
      title: names.length === 1 ? `Delete ${names[0]}?` : `Delete ${plural(names.length, "image")}?`,
      body: "They are removed from the data repo, committed and pushed. A body that still linked one would show a broken image.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetchRef.current(IMAGES_URL, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names }),
      });
      if (!res.ok) {
        toast.error(await errorOf(res));
        if (res.status === 409) await load();
        return;
      }
      const gone = new Set(names);
      setImages((list) => (list ? list.filter((i) => !gone.has(i.name)) : list));
      setSelected((s) => new Set([...s].filter((n) => !gone.has(n))));
      setOpen((o) => (o !== null && gone.has(o) ? null : o));
      toast.success(names.length === 1 ? `Deleted ${names[0]}` : `Deleted ${plural(names.length, "image")}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const total = (list: StoredImage[]) => list.reduce((sum, i) => sum + i.bytes, 0);
  const summary =
    images === null
      ? loading
        ? "Scanning the data repo…"
        : ""
      : tab === "unreferenced"
        ? `${unreferenced.length} of ${plural(all.length, "stored image")} ${unreferenced.length === 1 ? "is" : "are"} not referenced by any feature or page · ${formatBytes(total(unreferenced))}`
        : `${plural(all.length, "stored image")} · ${formatBytes(total(all))}`;

  const sections = [
    { id: "unreferenced", title: images ? `Unreferenced · ${unreferenced.length}` : "Unreferenced" },
    { id: "all", title: images ? `All · ${all.length}` : "All" },
  ];

  const opened = open === null ? null : (all.find((i) => i.name === open) ?? null);

  return (
    <AppPageLayout
      title="Images"
      className="wide images-page"
      sections={sections}
      tabs={{ active: tab, onSelect: (id) => setTab(id as Tab) }}
      actions={
        <Tooltip label="Rescan the data repo">
          <button type="button" className="ibtn" aria-label="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      }
      onClose={onClose}
    >
      <PageSection
        id={tab}
        title={tab === "unreferenced" ? "Unreferenced images" : "All images"}
        hint={
          tab === "unreferenced"
            ? "Stored under .images/ in the data repo but named by no feature, page or other file — drafts included. Pick the ones to delete."
            : "Every image stored in the data repo and the files that reference it."
        }
        panel
        className="images-panel"
      >
        <div className="data-toolbar">
          <p className="data-status">{summary}</p>
          {tab === "unreferenced" && canDelete && unreferenced.length > 0 && (
            <div className="images-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setSelected(new Set(unreferenced.map((i) => i.name)))}
                disabled={selected.size === unreferenced.length}
              >
                Select all
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Clear
              </button>
              <button
                type="button"
                className="btn btn-danger-solid"
                onClick={() => void deleteNames([...selected])}
                disabled={selected.size === 0 || deleting}
              >
                {deleting ? "Deleting…" : `Delete ${selected.size || ""}`.trim()}
              </button>
            </div>
          )}
        </div>
        {error && (
          <p className="data-muted images-error" role="alert">
            {error}
          </p>
        )}
        <div className={`data-rows${opened ? " with-drawer" : ""}`}>
          {images !== null && shown.length === 0 ? (
            <p className="empty images-empty">
              {all.length === 0 ? "No images are stored in the data repo." : "Every stored image is referenced."}
            </p>
          ) : (
            <ul className="image-grid" aria-label={tab === "unreferenced" ? "Unreferenced images" : "All images"}>
              {shown.map((image) => {
                const unused = image.referencedBy.length === 0;
                const isSelected = selected.has(image.name);
                return (
                  <li
                    key={image.name}
                    className={`image-card${isSelected ? " selected" : ""}${opened?.name === image.name ? " open" : ""}`}
                  >
                    {tab === "unreferenced" && canDelete && (
                      <input
                        type="checkbox"
                        className="image-check"
                        aria-label={`Select ${image.name}`}
                        checked={isSelected}
                        onChange={() => toggle(image.name)}
                      />
                    )}
                    <button
                      type="button"
                      className="image-thumb"
                      aria-label={`Open ${image.name}`}
                      aria-pressed={opened?.name === image.name}
                      onClick={() => setOpen(image.name)}
                    >
                      <img src={image.path} alt="" loading="lazy" decoding="async" />
                    </button>
                    <div className="image-meta">
                      <span className="image-name" title={image.name}>
                        {image.name}
                      </span>
                      <span className="image-size data-muted" title={unused ? undefined : image.referencedBy.join("\n")}>
                        {formatBytes(image.bytes)}
                        {tab === "all" && (unused ? " · unreferenced" : ` · used in ${plural(image.referencedBy.length, "file")}`)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {opened && (
            <aside className="data-drawer image-drawer" aria-label={`Preview of ${opened.name}`}>
              <div className="data-drawer-head">
                <span className="data-drawer-title" title={opened.name}>
                  {opened.name}
                </span>
                <button type="button" className="ibtn" aria-label="Close preview" onClick={() => setOpen(null)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              <img className="image-full" src={opened.path} alt={opened.name} />
              <dl className="image-details">
                <dt>Size</dt>
                <dd>{formatBytes(opened.bytes)}</dd>
                <dt>Used in</dt>
                <dd>
                  {opened.referencedBy.length === 0 ? (
                    <span className="data-muted">No file references it</span>
                  ) : (
                    <ul className="image-refs">
                      {opened.referencedBy.map((file) => (
                        <li key={file}>{fileLink(file)}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </dl>
              {opened.referencedBy.length === 0 && canDelete && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void deleteNames([opened.name])}
                  disabled={deleting}
                >
                  Delete
                </button>
              )}
            </aside>
          )}
        </div>
      </PageSection>
    </AppPageLayout>
  );
}
