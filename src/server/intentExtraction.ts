// Drafting a new specification folder's specs from the code, in the
// background (specs/app/extract-specs-from-code.feature.md "Progress and
// cancel", "Retry a folder; resume an interrupted run"): one job per
// specification folder, working through the chosen folders one at a time
// and each folder's batches one at a time — an agent turn each
// (src/server/intentDraft.ts), a feature file written for each answer.
//
// A turn can take minutes and a project has many folders, so nothing waits
// on a request: starting answers at once and the page polls the job's
// state, as it does for a clone (src/server/codeRepoClone.ts). The state
// is also kept in a file under the app's home folder — not in the
// specification folder, where the sync would commit it — so a run the app
// was closed on shows as interrupted on the next start and can be resumed.
// It never resumes by itself: an agent is not set to work unasked.
//
// Node APIs only: this module also runs under Electron (src/server/run.ts).

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { agents } from "../plugins/host/agents";
import { specdrivenHome } from "./appSource";
import { createFeature } from "./features";
import { planBatches, renderBatch, type DigestFile } from "./intentDigest";
import { DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, draftFromResult, draftPrompt, planExtractedFeature, type Draft } from "./intentDraft";
import { moduleFiles, ROOT_ID, type ModuleFiles } from "./intentModules";
import { ExtractError, type ChosenFolder } from "./intentRepo";
import { scanProject } from "./intentScan";
import { getLogger } from "./telemetry";
import { detached } from "./workspace";

const log = getLogger("extraction");

/** How long an agent gets for one batch before the turn is abandoned. */
const DRAFT_TIMEOUT_MS = 240_000;

/** What the job says when no agent here answers one-shot turns. */
export const NO_AGENT = "No agent is set up here to draft specs — switch one on in Settings → Plugins, then resume";
/** What it says of a run the app was closed on. */
export const WAS_CLOSED = "The app was closed while the specs were being drafted";

export type BatchState = "pending" | "running" | "done" | "empty" | "failed";

/** One agent turn's worth of a folder, and what came of it. */
export interface JobBatch {
  /** The part of the folder it covers; "" when the folder is drafted in one. */
  label: string;
  /** The files it shows the agent. */
  files: DigestFile[];
  state: BatchState;
  /** The feature it became, relative to the specification folder. */
  fileName?: string;
  title?: string;
  scenarios?: number;
  /** Why it has no feature: the agent found nothing to specify. */
  note?: string;
  error?: string;
}

export type FolderState = "pending" | "running" | "done" | "empty" | "failed" | "cancelled";

export interface JobFolder {
  /** The spec folder, under `specs/`. */
  folder: string;
  name: string;
  /** The directories in the project its specs are drafted from; "" is the project's top. */
  roots: string[];
  state: FolderState;
  batches: JobBatch[];
  /** How many of its files did not fit and were left unread. */
  notRead: number;
  /** The first thing that went wrong, when it failed. */
  error?: string;
}

export type JobState = "running" | "cancelling" | "cancelled" | "done" | "interrupted";

export interface ExtractionJob {
  id: string;
  /** The specification folder the features are written into. */
  dataDir: string;
  /** The code project they are drafted from. */
  codeDir: string;
  project: string;
  /** The agent asked for; none means whichever answers one-shot turns first. */
  agent?: string;
  model?: string;
  state: JobState;
  /** Why it is interrupted. */
  problem?: string;
  /** Who is drafting, once a turn has been asked for. */
  agentLabel?: string;
  folders: JobFolder[];
  startedAt: string;
}

interface Running {
  job: ExtractionJob;
  abort: AbortController | null;
  done: Promise<void> | null;
}

const running = new Map<string, Running>();

// --- The record on disk ----------------------------------------------------------------

const recordPath = (dataDir: string): string =>
  join(
    specdrivenHome(process.env, homedir()),
    "extractions",
    `${createHash("sha1").update(resolve(dataDir)).digest("hex").slice(0, 16)}.json`,
  );

async function save(job: ExtractionJob): Promise<void> {
  const path = recordPath(job.dataDir);
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(job, null, 2)}\n`);
  } catch (e) {
    // The run goes on without its record; only a restart would lose it.
    log.warn("could not save the extraction's state", { "error.message": (e as Error).message });
  }
}

/** The record as the last run left it; one cut short by the app closing reads as interrupted. */
async function load(dataDir: string): Promise<ExtractionJob | null> {
  let job: ExtractionJob;
  try {
    job = JSON.parse(await readFile(recordPath(dataDir), "utf8")) as ExtractionJob;
  } catch {
    return null;
  }
  if (!job || typeof job !== "object" || !Array.isArray(job.folders) || resolve(job.dataDir) !== resolve(dataDir)) return null;
  if (job.state === "running" || job.state === "cancelling") {
    job.state = "interrupted";
    job.problem = WAS_CLOSED;
    for (const folder of job.folders) {
      if (folder.state === "running") folder.state = "pending";
      for (const batch of folder.batches) if (batch.state === "running") batch.state = "pending";
    }
  }
  return job;
}

// --- Planning ---------------------------------------------------------------------------

/** The files several analysed folders own, together. */
function union(owned: ReadonlyMap<string, ModuleFiles>, ids: readonly string[]): ModuleFiles {
  const all: ModuleFiles = { source: [], tests: [], rest: [] };
  for (const id of ids) {
    const files = owned.get(id);
    if (!files) continue;
    all.source.push(...files.source);
    all.tests.push(...files.tests);
    all.rest.push(...files.rest);
  }
  return all;
}

/**
 * The folders to draft, each with its batches planned: the project is read
 * once, the files each chosen folder draws on are gathered, and what will
 * be shown to the agent is settled before the first turn — so the progress
 * the page shows is of a known amount of work.
 */
async function plan(codeDir: string, chosen: readonly ChosenFolder[]): Promise<JobFolder[]> {
  const snapshot = await scanProject(codeDir);
  const owned = moduleFiles(snapshot);
  const sizes = new Map(snapshot.files.map((f) => [f.path, f.size]));
  return chosen
    .filter((f) => f.draft)
    .map((f): JobFolder => {
      const { batches, notRead } = planBatches(union(owned, f.modules), sizes);
      return {
        folder: f.folder,
        name: f.name || f.folder.split("/").pop()!,
        roots: f.modules.map((id) => (id === ROOT_ID ? "" : id)),
        state: batches.length === 0 ? "empty" : "pending",
        batches: batches.map((b) => ({ label: b.label, files: b.files, state: "pending" })),
        notRead: notRead.length,
      };
    });
}

// --- The run ----------------------------------------------------------------------------

/** Write a draft as a feature in its folder; a name already taken there gets a number. */
async function writeFeature(job: ExtractionJob, folder: JobFolder, draft: Draft): Promise<{ fileName: string; title: string }> {
  for (let n = 1; ; n++) {
    const title = n === 1 ? draft.title : `${draft.title} (${n})`;
    const feature = planExtractedFeature({ ...draft, title }, folder.roots);
    try {
      const fileName = await createFeature(
        job.dataDir,
        `${folder.folder}/${feature.name}`,
        feature.text,
        (name) => `Extract feature from code: ${name} (${folder.roots.map((r) => r || job.project).join(", ")})`,
      );
      return { fileName, title: feature.name };
    } catch (e) {
      if (n < 20 && /^Feature file already exists: /.test((e as Error).message)) continue;
      throw e;
    }
  }
}

/** What a folder's batches add up to. */
function folderOutcome(folder: JobFolder): Pick<JobFolder, "state" | "error"> {
  const failed = folder.batches.find((b) => b.state === "failed");
  if (failed) return { state: "failed", error: failed.error ?? "the turn failed" };
  if (folder.batches.some((b) => b.state === "pending" || b.state === "running")) return { state: "pending" };
  return { state: folder.batches.some((b) => b.state === "done") ? "done" : "empty" };
}

async function run(entry: Running): Promise<void> {
  const { job } = entry;
  const abort = new AbortController();
  entry.abort = abort;
  job.state = "running";
  delete job.problem;
  await save(job);
  const stopped = () => abort.signal.aborted;

  folders: for (const folder of job.folders) {
    if (stopped()) break;
    if (folder.state !== "pending") continue;
    folder.state = "running";
    delete folder.error;
    await save(job);
    for (const [index, batch] of folder.batches.entries()) {
      if (stopped()) break;
      if (batch.state !== "pending") continue;
      const provider = agents.oneShot(job.agent);
      if (!provider?.oneShot) {
        // Nothing to ask: the run waits for an agent rather than failing every folder.
        folder.state = "pending";
        job.state = "interrupted";
        job.problem = NO_AGENT;
        entry.abort = null;
        await save(job);
        return;
      }
      job.agentLabel = provider.label;
      batch.state = "running";
      delete batch.error;
      await save(job);
      try {
        const rendered = await renderBatch(job.codeDir, batch);
        if (rendered.shown.length === 0) {
          batch.state = "empty";
          batch.note = "none of its files could be read";
        } else {
          const result = await provider.oneShot({
            // The specification folder, never the project: an agent that can read
            // files where it runs is shown the project only through this prompt.
            cwd: job.dataDir,
            systemPrompt: DRAFT_SYSTEM_PROMPT,
            prompt: draftPrompt(
              {
                project: job.project,
                folder: folder.name,
                roots: folder.roots,
                ...(folder.batches.length > 1 ? { part: { label: batch.label, index: index + 1, of: folder.batches.length } } : {}),
                earlier: folder.batches.filter((b) => b.title).map((b) => b.title!),
              },
              rendered.text,
            ),
            schema: DRAFT_SCHEMA,
            ...(job.model ? { model: job.model } : {}),
            timeoutMs: DRAFT_TIMEOUT_MS,
            signal: abort.signal,
          });
          // An answer that arrives after a cancel is not written.
          if (stopped()) {
            batch.state = "pending";
            break;
          }
          if (result.isError) throw new Error(result.text.trim() || "the turn failed");
          const draft = draftFromResult(result, rendered.shown);
          if (!draft) throw new Error(`${provider.label} did not answer with a title and scenarios`);
          if (draft.scenarios.length === 0) {
            batch.state = "empty";
            batch.note = draft.skipped;
          } else {
            const written = await writeFeature(job, folder, draft);
            batch.state = "done";
            batch.fileName = written.fileName;
            batch.title = written.title;
            batch.scenarios = draft.scenarios.length;
          }
        }
      } catch (e) {
        // A cancel ends the turn with an error of its own: that is not a failure.
        if (stopped()) {
          batch.state = "pending";
          break;
        }
        batch.state = "failed";
        batch.error = (e as Error).message;
        log.warn("drafting a batch failed", { "specdriven.folder": folder.folder, "error.message": batch.error });
      }
      await save(job);
    }
    if (stopped()) {
      Object.assign(folder, folderOutcome(folder));
      break folders;
    }
    Object.assign(folder, folderOutcome(folder));
    await save(job);
  }

  if (stopped()) {
    for (const folder of job.folders) if (folder.state === "pending" || folder.state === "running") folder.state = "cancelled";
    job.state = "cancelled";
  } else {
    job.state = "done";
  }
  entry.abort = null;
  await save(job);
}

function launch(entry: Running): void {
  // Nobody's work: the run outlives the request, and the window, that started it.
  entry.done = detached(() =>
    run(entry).catch(async (e) => {
      entry.job.state = "interrupted";
      entry.job.problem = (e as Error).message;
      entry.abort = null;
      await save(entry.job);
    }),
  );
}

const busy = (job: ExtractionJob | undefined): boolean => job?.state === "running" || job?.state === "cancelling";

/** A copy to answer with: the caller cannot reach into the run. */
const view = (job: ExtractionJob): ExtractionJob => structuredClone(job);

// --- What the routes call ---------------------------------------------------------------

export interface StartOptions {
  dataDir: string;
  codeDir: string;
  folders: readonly ChosenFolder[];
  agent?: string;
  model?: string;
}

/**
 * Start drafting specs for a specification folder's chosen folders. Answers
 * as soon as the work is planned; the drafting goes on in the background.
 * Refused while a run for the folder is already going. With no agent to ask
 * the job is made all the same, interrupted, so it can be resumed once one
 * is switched on.
 */
export async function startExtraction(options: StartOptions): Promise<ExtractionJob> {
  const key = resolve(options.dataDir);
  if (busy(running.get(key)?.job)) throw new ExtractError(409, "Specs are being drafted for this folder already");
  const folders = await plan(options.codeDir, options.folders);
  const job: ExtractionJob = {
    id: randomUUID(),
    dataDir: key,
    codeDir: resolve(options.codeDir),
    project: basename(resolve(options.codeDir)),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.model ? { model: options.model } : {}),
    state: "running",
    folders,
    startedAt: new Date().toISOString(),
  };
  const entry: Running = { job, abort: null, done: null };
  running.set(key, entry);
  await save(job);
  launch(entry);
  return view(job);
}

/** The folder's extraction as it stands — from this run, or the record an earlier one left — or null. */
export async function extractionOf(dataDir: string): Promise<ExtractionJob | null> {
  const key = resolve(dataDir);
  const entry = running.get(key);
  if (entry) return view(entry.job);
  const job = await load(key);
  if (job) running.set(key, { job, abort: null, done: null });
  return job ? view(job) : null;
}

/** Stop a run: the turn in flight is abandoned, and what is not started stays undone. */
export async function cancelExtraction(dataDir: string): Promise<ExtractionJob | null> {
  const entry = running.get(resolve(dataDir));
  if (!entry) return extractionOf(dataDir);
  if (entry.job.state === "running" && entry.abort) {
    entry.job.state = "cancelling";
    entry.abort.abort();
  }
  return view(entry.job);
}

/**
 * Take up again what did not get done: a folder that failed, was cancelled
 * or was never reached — one of them when `folder` names it, else all — has
 * its unfinished batches tried again. A batch that became a feature, or
 * held nothing to specify, is never redone.
 */
export async function retryExtraction(dataDir: string, folder?: string): Promise<ExtractionJob> {
  const key = resolve(dataDir);
  if (!(await extractionOf(key))) throw new ExtractError(404, "No specs were being drafted for this folder");
  const entry = running.get(key)!;
  if (busy(entry.job)) throw new ExtractError(409, "Specs are still being drafted — wait for the run to finish, or cancel it");
  let reset = 0;
  for (const f of entry.job.folders) {
    if (folder !== undefined && f.folder !== folder) continue;
    if (f.state === "done" || f.state === "empty") continue;
    for (const batch of f.batches) {
      if (batch.state === "failed" || batch.state === "running") batch.state = "pending";
      delete batch.error;
    }
    if (f.batches.some((b) => b.state === "pending")) {
      f.state = "pending";
      delete f.error;
      reset++;
    }
  }
  if (reset === 0) throw new ExtractError(409, folder ? `Nothing is left to draft in ${folder}` : "Nothing is left to draft");
  // A folder left cancelled while another is retried stays so: the run takes only what is pending.
  launch(entry);
  entry.job.state = "running";
  return view(entry.job);
}

/** Forget a finished or stopped run: its record goes, the features it wrote stay. */
export async function dismissExtraction(dataDir: string): Promise<void> {
  const key = resolve(dataDir);
  if (busy(running.get(key)?.job)) throw new ExtractError(409, "Specs are still being drafted — cancel the run first");
  running.delete(key);
  await rm(recordPath(key), { force: true });
}

/** The app is closing: every run stops where it is, and its record says so. */
export async function interruptExtractions(): Promise<void> {
  const stopped = [...running.values()].filter((entry) => entry.job.state === "running");
  for (const entry of stopped) entry.abort?.abort();
  await Promise.all(stopped.map((entry) => entry.done));
  for (const entry of stopped) {
    if (entry.job.state !== "cancelled") continue;
    entry.job.state = "interrupted";
    entry.job.problem = WAS_CLOSED;
    for (const folder of entry.job.folders) if (folder.state === "cancelled") folder.state = "pending";
    await save(entry.job);
  }
}

/** Tests: wait for the folder's run to end. */
export async function extractionSettled(dataDir: string): Promise<void> {
  await running.get(resolve(dataDir))?.done;
}

/** Tests: forget every run. */
export function resetExtractions(): void {
  for (const entry of running.values()) entry.abort?.abort();
  running.clear();
}
