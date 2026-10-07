// GitHub issue tracking's host half (specs/app/github-issues.feature.md):
// the issues of the repository the data repo's code-repo pushes to
// (src/server/issues.ts), on routes that exist only while the plugin is
// mounted — so a switched-off module answers 404 with no per-route check.
// Every call goes to GitHub as the user; a data repo whose code repo is not
// a GitHub one has no issues to show.
//
// The demo reads the public release repo (demo.ts DEMO_ISSUES_REPO) so its
// Issues tab shows real issues, but stays read-only: a visitor is signed in
// to nothing, so a write would be an anonymous one on a public repository —
// refused here rather than sent to GitHub to fail.

import type { Context, Plugin } from "../../kernel";
import type { DataAccess } from "../../host/services";
import { bodyOf, json, type Handler, type Params } from "../../../server/http";
import { isDemoMode } from "../../../server/demoMode";
import { PROJECT_SETTINGS_FILE } from "../../../server/members";
import {
  GitHubError,
  addComment,
  createIssue,
  getIssue,
  listComments,
  listIssues,
  parseIssueNumber,
  readIssuesRepo,
  updateIssue,
  type GitHubRepo,
  type IssueState,
} from "../../../server/issues";
import { manifest } from "./manifest";

type RepoHandler = (repo: GitHubRepo, req: Request, params: Params) => Response | Promise<Response>;

const ISSUE_STATES: IssueState[] = ["open", "closed", "all"];

/** Against the code repo's GitHub repository, with GitHub's errors as answers. */
const guarded =
  (data: DataAccess) =>
  (handler: RepoHandler, { readOnlyInDemo = false }: { readOnlyInDemo?: boolean } = {}): Handler =>
    data.withDir(async (dir, req, params) => {
      if (readOnlyInDemo && isDemoMode()) {
        return json({ error: "The demo cannot change GitHub issues" }, 403);
      }
      const repo = await readIssuesRepo(dir);
      if (repo === null) {
        return json(
          { error: `No GitHub code repo: ${PROJECT_SETTINGS_FILE} must name one in code-repo` },
          404,
        );
      }
      try {
        return await handler(repo, req, params);
      } catch (e) {
        const status = e instanceof GitHubError ? e.status : 502;
        return json({ error: (e as Error).message }, status);
      }
    });

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["routes", "data"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const on = guarded(ctx.need("data"));
    const add = (method: string, pattern: string, handler: Handler) =>
      ctx.effect(() => routes.add(method, pattern, handler));

    add(
      "GET",
      "/api/issues",
      on(async (repo, req) => {
        const wanted = new URL(req.url).searchParams.get("state");
        const state = ISSUE_STATES.find((s) => s === wanted) ?? "open";
        return json({ repo, state, issues: await listIssues(repo, state) });
      }),
    );
    add(
      "POST",
      "/api/issues",
      on(async (repo, req) => json({ issue: await createIssue(repo, await bodyOf(req)) }, 201), {
        readOnlyInDemo: true,
      }),
    );
    add(
      "GET",
      "/api/issues/:number",
      on(async (repo, _req, params) => {
        const number = parseIssueNumber(params.number);
        const [issue, comments] = await Promise.all([getIssue(repo, number), listComments(repo, number)]);
        return json({ issue, comments });
      }),
    );
    add(
      "PUT",
      "/api/issues/:number",
      on(
        async (repo, req, params) =>
          json({ issue: await updateIssue(repo, parseIssueNumber(params.number), await bodyOf(req)) }),
        { readOnlyInDemo: true },
      ),
    );
    add(
      "POST",
      "/api/issues/:number/comments",
      on(
        async (repo, req, params) =>
          json(
            { comment: await addComment(repo, parseIssueNumber(params.number), (await bodyOf(req)).body) },
            201,
          ),
        { readOnlyInDemo: true },
      ),
    );
  },
};

export default plugin;
