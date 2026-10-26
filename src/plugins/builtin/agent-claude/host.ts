// The Claude agent plugin's host half (specs/agents/claude.feature.md,
// specs/agents/agent-plugins.feature.md): the provider on the agent
// registry (src/plugins/builtin/agent-claude/provider.ts — in demo mode,
// the scripted stand-in from src/server/demoAgent.ts), and the routes for
// how Claude signs in: the mode, what Claude Code's own settings say of a
// proxy, the login driven from Settings, a check of the proxy, and the
// plugin's own settings. The proxy token never leaves the server — the
// page learns only whether there is one. A local Claude only, so every
// route refuses in the hosted app and the demo.

import { homedir } from "node:os";
import type { Context, Plugin } from "../../kernel";
import type { HostConfig } from "../../host/loader";
import { json, type Handler } from "../../../server/http";
import { claudeAvailable } from "../../../server/agent";
import { clearClaudeToken, loadClaudeToken, saveClaudeToken } from "../../../server/claudeToken";
import { isDemoMode } from "../../../server/demoMode";
import { HOSTED_REFUSAL, isHostedMode } from "../../../server/hostedMode";
import { getAppRoot } from "../../../server/paths";
import { readState } from "../../../server/state";
import { simulatedProvider } from "../../../server/demoAgent";
import {
  ClaudeAuthError,
  cancelLogin,
  checkProxy,
  detectClaudeProxy,
  effectiveClaudeAuth,
  loginState,
  loginStatus,
  logout as claudeLogout,
  startLogin,
} from "./auth";
import type { EffectiveClaudeAuth, LoginStatus } from "./auth";
import { manifest } from "./manifest";
import { claudeProvider } from "./provider";
import { ADOPTED_KEY, CLAUDE_LEGACY_KEYS, claudeSettingsOf, claudeSettingsPatch } from "./settings";

export const DEMO_REFUSAL = "Claude sign-in is disabled in demo mode";

/** Refused where there is no local Claude; otherwise the handler. */
const guarded =
  (handler: Handler): Handler =>
  (req, params) => {
    if (isHostedMode()) return json({ error: HOSTED_REFUSAL }, 403);
    if (isDemoMode()) return json({ error: DEMO_REFUSAL }, 403);
    return handler(req, params);
  };

/** A settings file's path with the home folder as ~, for the page. */
function tilde(path: string | null): string | null {
  const home = homedir();
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function claudeAuthView(auth: EffectiveClaudeAuth, login: LoginStatus, firstResponseSeconds: number) {
  return {
    mode: auth.mode,
    inferred: auth.inferred,
    cliAvailable: claudeAvailable(),
    login,
    proxy: {
      /** The url in effect: the stored one, else the detected one. */
      url: auth.storedUrl ?? auth.detected.url,
      storedUrl: auth.storedUrl,
      storedToken: auth.storedToken,
      hasToken: auth.storedToken || auth.detected.token !== null,
      detected: {
        url: auth.detected.url,
        urlSource: tilde(auth.detected.urlSource),
        hasToken: auth.detected.token !== null,
        tokenSource: tilde(auth.detected.tokenSource),
      },
    },
    /** The pane's first-response wait behind the proxy; 0 is no limit. */
    firstResponseSeconds,
    signIn: loginState(),
  };
}

const claudeFailure = (e: unknown) =>
  e instanceof ClaudeAuthError ? json({ error: e.message }, e.status) : json({ error: (e as Error).message }, 502);

const plugin: Plugin<Context, HostConfig> = {
  name: manifest.id,
  inject: ["routes", "agents", "data"],
  async apply(ctx, config) {
    const agents = ctx.need("agents");
    const routes = ctx.need("routes");
    const data = ctx.need("data");

    // The provider: the real one, or the demo's script under the same id.
    ctx.effect(() => agents.register(isDemoMode() ? simulatedProvider : claudeProvider));

    // The values that lived at the top of settings.json before the plugin
    // come into its own section once; the old keys stay for one release.
    try {
      await config.settings.adopt(CLAUDE_LEGACY_KEYS);
      if ((await config.settings.read())[ADOPTED_KEY] !== true) await config.settings.write({ [ADOPTED_KEY]: true });
    } catch (e) {
      console.error(`[agent-claude] adopting settings: ${(e as Error).message}`);
    }

    /** Where Claude Code's project settings would be read from: the open
        data folder, else the app root. */
    const claudeCwd = async (): Promise<string> => {
      try {
        return (await data.dir()) ?? getAppRoot();
      } catch {
        return getAppRoot();
      }
    };

    const answer = async (): Promise<Response> => {
      const state = await readState(getAppRoot());
      const auth = await effectiveClaudeAuth(state, await claudeCwd());
      return json(claudeAuthView(auth, await loginStatus(), claudeSettingsOf(state).firstResponseSeconds));
    };

    const getAuth: Handler = () => answer();

    const postToken: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 1024) {
        return json({ error: "Paste the proxy's token" }, 400);
      }
      await saveClaudeToken({ token: body.token.trim() });
      return answer();
    };

    const deleteToken: Handler = async () => {
      await clearClaudeToken();
      return answer();
    };

    // "Use detected": the url and token Claude Code's settings or the
    // environment carry become the app's own, copied server-side so the
    // token never passes through the page.
    const postProxyDetect: Handler = async () => {
      const detected = await detectClaudeProxy(await claudeCwd());
      if (!detected.url) return json({ error: "No proxy found in Claude Code's settings or the environment" }, 404);
      await config.settings.write({ claudeProxyUrl: detected.url });
      if (detected.token) await saveClaudeToken({ token: detected.token });
      return answer();
    };

    const postProxyCheck: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { url?: unknown };
      const auth = await effectiveClaudeAuth(await readState(getAppRoot()), await claudeCwd());
      const typed = typeof body.url === "string" ? claudeSettingsPatch({ claudeProxyUrl: body.url }) : null;
      const url =
        (typed && "patch" in typed ? (typed.patch.claudeProxyUrl as string | null) : null) ||
        auth.storedUrl ||
        auth.detected.url;
      if (!url) return json({ error: "Enter the proxy's url first" }, 400);
      const token = (await loadClaudeToken())?.token ?? auth.detected.token;
      return json({ url, ...(await checkProxy(url, token)) });
    };

    const postLogin: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { email?: unknown };
      try {
        return json({ signIn: await startLogin(typeof body.email === "string" ? body.email : "") });
      } catch (e) {
        return claudeFailure(e);
      }
    };

    const getLogin: Handler = async () => json({ signIn: loginState(), login: await loginStatus() });

    const deleteLogin: Handler = () => json({ signIn: cancelLogin() });

    const postLogout: Handler = async () => {
      try {
        await claudeLogout();
      } catch (e) {
        return claudeFailure(e);
      }
      return answer();
    };

    // The plugin's own settings: the mode, the proxy url, the first-response wait.
    const getSettings: Handler = async () => json(claudeSettingsOf(await readState(getAppRoot())));

    const putSettings: Handler = async (req) => {
      const parsed = claudeSettingsPatch(await req.json().catch(() => null));
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await config.settings.write(parsed.patch);
      return json(claudeSettingsOf(await readState(getAppRoot())));
    };

    const add = (method: string, pattern: string, handler: Handler) =>
      ctx.effect(() => routes.add(method, pattern, guarded(handler)));
    add("GET", "/api/claude/auth", getAuth);
    add("POST", "/api/claude/token", postToken);
    add("DELETE", "/api/claude/token", deleteToken);
    add("POST", "/api/claude/proxy/detect", postProxyDetect);
    add("POST", "/api/claude/proxy/check", postProxyCheck);
    add("POST", "/api/claude/login", postLogin);
    add("GET", "/api/claude/login", getLogin);
    add("DELETE", "/api/claude/login", deleteLogin);
    add("POST", "/api/claude/logout", postLogout);
    add("GET", "/api/claude/settings", getSettings);
    add("PUT", "/api/claude/settings", putSettings);
  },
};

export default plugin;
