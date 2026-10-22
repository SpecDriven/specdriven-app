import { useState, type Ref } from "react";
import type { Feature } from "../server/parser";
import { parseModuleUrl, sameQtestBase } from "../server/qtestUrl";
import type { QtestSite } from "./QtestToken";
import { PromptChoices } from "./ModalPrompts";

// "Create qTest test cases…" from a feature's ⋯ menu
// (specs/external-links/qtest-test-cases.feature.md "Create qTest test cases
// from a feature"): the parent module to create them under, which scenarios
// go in, and Create. The server makes a module named after the feature under
// it, one test case per scenario, and links each from the feature.

export type PublishScope = "all" | "published";

/** What the route answers: the module, the test cases, and the feature as saved. */
export interface QtestPublishResult {
  module: { id: string; pid: string; url: string; created: boolean };
  cases: { scenarioName: string; id: string; pid: string; url: string; created: boolean }[];
  created: number;
  updated: number;
  title: string;
  parentUrl: string;
  content: string;
  parsed: Feature;
  message?: string;
  warning?: string;
}

const SCOPES = [
  { value: "all", label: "All scenarios", hint: "Published, proposed and draft" },
  { value: "published", label: "Published scenarios only" },
];

/**
 * What stands between the url typed and a publish: nothing (null), or the
 * one sentence the dialog shows under the field.
 */
export function parentModuleProblem(parentUrl: string, sites: QtestSite[]): string | null {
  if (!parentUrl.trim()) return "Paste the url of the module to create the test cases under.";
  const ref = parseModuleUrl(parentUrl);
  if (!ref) return "Not a qTest module url — select the module in Test Design and copy the address.";
  if (!sites.some((s) => sameQtestBase(s.base, ref.base))) {
    return `No token for ${ref.base} — add one in Settings → qTest.`;
  }
  return null;
}

export function QtestPublishDialog({
  file,
  featureName,
  linkedUrl,
  initialParentUrl,
  sites,
  trapRef,
  onPublished,
  onClose,
}: {
  file: string;
  featureName: string;
  /** The module the feature already links, when its test cases were created before. */
  linkedUrl?: string;
  initialParentUrl: string;
  sites: QtestSite[];
  trapRef?: Ref<HTMLDivElement>;
  onPublished: (result: QtestPublishResult) => void;
  onClose: () => void;
}) {
  const [parentUrl, setParentUrl] = useState(initialParentUrl);
  const [scope, setScope] = useState<PublishScope>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = parentModuleProblem(parentUrl, sites);

  const publish = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/qtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentUrl: parentUrl.trim(), scope }),
      });
      const data = (await res.json()) as QtestPublishResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Creating the test cases failed (HTTP ${res.status})`);
        return;
      }
      onPublished(data);
    } catch {
      setError("Could not reach the server — is it running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog modal-dialog confluence-dialog qtest-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create qTest test cases"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void publish();
          }}
        >
          <h3>Create qTest test cases</h3>
          <p>
            Each scenario of <strong>{featureName}</strong> becomes a test case in a module named after the feature,
            under the parent module
            {linkedUrl ? (
              <>
                ; creating them again updates{" "}
                <a href={linkedUrl} target="_blank" rel="noreferrer">
                  its module
                </a>
              </>
            ) : null}
            .
          </p>
          <label>
            Parent module url
            <input
              aria-label="Parent module url"
              autoFocus
              value={parentUrl}
              onChange={(e) => setParentUrl(e.target.value)}
              placeholder="https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=2&id=901"
            />
          </label>
          {parentUrl.trim() && problem && <p className="hint">{problem}</p>}
          <PromptChoices
            label="Scenarios"
            choices={SCOPES}
            value={scope}
            onChange={(v) => setScope(v === "published" ? "published" : "all")}
          />
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || problem !== null}>
              {busy ? "Creating…" : "Create test cases"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
