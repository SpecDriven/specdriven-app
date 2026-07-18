// Local state lives in a .specdriven file (JSON) in the project root.
// Per specs/app-start.spec.md: if it doesn't name the last data repo,
// the UI must ask the user for one.

export interface SpecDrivenState {
  dataRepo?: string;
}

export const STATE_FILE = ".specdriven";

export async function readState(rootDir: string = process.cwd()): Promise<SpecDrivenState> {
  const file = Bun.file(`${rootDir}/${STATE_FILE}`);
  if (!(await file.exists())) return {};
  try {
    const parsed = await file.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as SpecDrivenState) : {};
  } catch {
    return {};
  }
}

export async function writeState(
  state: SpecDrivenState,
  rootDir: string = process.cwd(),
): Promise<void> {
  await Bun.write(`${rootDir}/${STATE_FILE}`, JSON.stringify(state, null, 2) + "\n");
}

export function needsDataRepo(state: SpecDrivenState): boolean {
  return !state.dataRepo || state.dataRepo.trim() === "";
}
