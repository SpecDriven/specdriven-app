// The Fix this app module's urls (specs/app/self-healing.feature.md):
//
//   /fix-app              the form for a new fix
//   /fix-app/<id>         one fix: its session, diff and the rebuild/restart/revert controls

/** The module's views: the form, or one fix. */
export type SelfFixRoute = { kind: "new" } | { kind: "fix"; id: string };

const ID = /^[0-9a-f-]{36}$/;

/** The view a url names, or null when the url is not the module's. */
export function parseSelfFixRoute(pathname: string): SelfFixRoute | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs[0] !== "fix-app") return null;
  if (segs[1] && ID.test(segs[1]) && !segs[2]) return { kind: "fix", id: segs[1] };
  return { kind: "new" };
}

/** The url of a view — the inverse of parseSelfFixRoute. */
export function selfFixPath(view: SelfFixRoute): string {
  return view.kind === "new" ? "/fix-app" : `/fix-app/${view.id}`;
}
