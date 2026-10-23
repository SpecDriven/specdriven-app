import { useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import { parseAhaRecordUrl, parseAhaRef, sameAhaBase } from "../server/ahaUrl";
import type { AhaSite } from "./AhaToken";
import { PromptChoices } from "./ModalPrompts";

// "Import from Aha!…" beside "New feature"
// (specs/external-links/aha-import.feature.md "Import a feature by its url",
// "Requirements become scenarios"): the Aha! feature's url — or its
// reference number against a site with a key — what of it comes along, and
// Import. The server reads the record and writes the feature file, its
// requirements as scenarios, each linking its Aha! record.

export type AhaImportScope = "requirements" | "description";

/** What the route answers: the feature file written, and the record it came from. */
export interface AhaImportResult {
  fileName: string;
  title: string;
  url: string;
  reference: string;
  scenarios: number;
  ahaLinks: boolean;
  warning?: string;
}

const SCOPES = [
  { value: "requirements", label: "Requirements as scenarios", hint: "Each requirement becomes a proposed scenario" },
  { value: "description", label: "Description only" },
];

const SITE_KEY = "specdriven.ahaSite";

function lastSite(sites: AhaSite[]): string {
  try {
    const kept = localStorage.getItem(SITE_KEY);
    if (kept && sites.some((s) => sameAhaBase(s.base, kept))) return kept;
  } catch {
    // no storage: the first site
  }
  return sites[0]?.base ?? "";
}

/**
 * What stands between the text typed and an import: nothing (null), or the
 * one sentence the dialog shows under the field. `base` is the site a bare
 * reference number is read against.
 */
export function importUrlProblem(url: string, base: string, sites: AhaSite[]): string | null {
  if (!url.trim()) return "Paste the url of the Aha! feature to import, or its reference number (APP-123).";
  const byUrl = parseAhaRecordUrl(url);
  const ref = byUrl ?? (base ? parseAhaRef(url, base) : null);
  if (!ref) {
    if (sites.length === 0) return "No Aha! API key on this device — add one in Settings → Aha!.";
    return "Not an Aha! feature url — open the feature in Aha! and copy the address, or type its reference number.";
  }
  if (ref.kind !== "feature") return `Only an Aha! feature can be imported for now; ${ref.ref} is an ${ref.kind}.`;
  if (!sites.some((s) => sameAhaBase(s.base, ref.base))) {
    return `No API key for ${ref.base} — add one in Settings → Aha!.`;
  }
  return null;
}

export function AhaImportDialog({
  folder,
  sites,
  trapRef,
  onImported,
  onClose,
}: {
  /** The folder the feature lands in, or null for the top level. */
  folder: string | null;
  sites: AhaSite[];
  trapRef?: Ref<HTMLDivElement>;
  onImported: (result: AhaImportResult) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [base, setBase] = useState(() => lastSite(sites));
  const [scope, setScope] = useState<AhaImportScope>("requirements");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = importUrlProblem(url, base, sites);
  const bareRef = url.trim() !== "" && parseAhaRecordUrl(url) === null;

  const chooseSite = (next: string) => {
    setBase(next);
    try {
      localStorage.setItem(SITE_KEY, next);
    } catch {
      // no storage: remembered for this dialog only
    }
  };

  const importNow = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/aha/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), base, folder, scope }),
      });
      const data = (await res.json()) as AhaImportResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Importing failed (HTTP ${res.status})`);
        return;
      }
      onImported(data);
    } catch {
      setError("Could not reach the server — is it running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog modal-dialog confluence-dialog aha-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import from Aha!"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void importNow();
          }}
        >
          <h3>Import from Aha!</h3>
          <p>
            The Aha! feature becomes a new feature {folder ? <>in <strong>{folder}</strong></> : "at the top level"}:
            its name and description from Aha!, and a link back to the record.
          </p>
          <label>
            Aha! feature url
            <input
              aria-label="Aha! feature url"
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://acme.aha.io/features/APP-123"
            />
          </label>
          {bareRef && sites.length > 1 && (
            <label>
              Aha! site
              <select aria-label="Aha! site" value={base} onChange={(e) => chooseSite(e.target.value)}>
                {sites.map((s) => (
                  <option key={s.base} value={s.base}>
                    {s.base}
                  </option>
                ))}
              </select>
            </label>
          )}
          {url.trim() && problem && <p className="hint">{problem}</p>}
          <PromptChoices
            label="Bring along"
            choices={SCOPES}
            value={scope}
            onChange={(v) => setScope(v === "description" ? "description" : "requirements")}
          />
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || problem !== null}>
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
