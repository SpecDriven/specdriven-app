// The plugin developer loop on the command line (roadmap/plugin-architecture
// .md "Developer loop", specs/app/plugins.feature.md "A plugin loads from a
// local folder"): `specdriven plugin new <id> [dir]` scaffolds both halves,
// `plugin build [dir]` bundles them into `dist/` the way the app does — the
// browser half over the app's React — and `plugin link <dir>` adds the
// folder to the profile's sources, so the running app finds it.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { version as appVersion } from "../../package.json";
import { getAppRoot } from "../server/paths";
import { readState, writeState } from "../server/state";
import { API_MAJOR, PLUGIN_ID_PATTERN, parsePackageManifest } from "./manifest";
import { buildClient, buildHost, canBuild } from "./host/build";
import { PROFILE_KEY } from "./profile";

const USAGE = `Usage:
  specdriven plugin new <id> [dir]   scaffold a plugin (both halves) in <dir>, default ./<id>
  specdriven plugin build [dir]      bundle src/ into dist/, default the current folder
  specdriven plugin link <dir>       add a plugin folder to this machine's profile

A plugin is a package whose package.json has a "specdriven" section; see the
scaffold's README. The app builds a linked TypeScript plugin itself when it
runs on Bun and rebuilds it as you edit; the desktop app loads dist/ only,
which "plugin build" writes.`;

export interface CliIo {
  log(line: string): void;
  error(line: string): void;
}

/** Run `specdriven plugin …`; the exit code is returned, not applied. */
export async function runPluginCli(
  args: string[],
  io: CliIo = { log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "new":
        return await scaffold(rest, io);
      case "build":
        return await build(rest, io);
      case "link":
        return await link(rest, io);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.log(USAGE);
        return command ? 0 : 2;
      default:
        io.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    io.error((e as Error).message);
    return 1;
  }
}

// ---- new --------------------------------------------------------------------

async function scaffold(args: string[], io: CliIo): Promise<number> {
  const [id, dirArg] = args;
  if (!id) {
    io.error(`A plugin id is needed.\n\n${USAGE}`);
    return 2;
  }
  if (!PLUGIN_ID_PATTERN.test(id)) {
    io.error(`"${id}" is not a plugin id: lowercase letters, digits, ".", "_", "-", optionally @scope/.`);
    return 2;
  }
  const dir = resolve(dirArg ?? id.replace(/^@[^/]+\//, ""));
  const existing = await readdir(dir).catch(() => null);
  if (existing && existing.length > 0) {
    io.error(`${dir} exists and is not empty.`);
    return 1;
  }
  await mkdir(join(dir, "src"), { recursive: true });
  for (const [name, content] of Object.entries(templates(id))) {
    await writeFile(join(dir, name), content);
  }
  io.log(`Scaffolded ${id} in ${dir}:`);
  for (const name of Object.keys(templates(id))) io.log(`  ${name}`);
  io.log(`\nNext:\n  specdriven plugin link ${dir}\nthen start (or restart) the app: the tab appears, and edits rebuild it.`);
  return 0;
}

/** The files of a new plugin, by relative path. */
export function templates(id: string): Record<string, string> {
  const short = id.replace(/^@[^/]+\//, "");
  const title = short
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  const route = `/${short}`;
  const api = `/api/${short}`;
  return {
    "package.json": `${JSON.stringify(
      {
        name: id,
        version: "0.1.0",
        type: "module",
        private: true,
        exports: { ".": "./dist/host.js", "./client": "./dist/client.js" },
        scripts: { build: "specdriven plugin build" },
        specdriven: {
          id,
          api: String(API_MAJOR),
          displayName: title,
          description: `${title} on its own tab`,
          host: "./dist/host.js",
          client: "./dist/client.js",
          src: { host: "./src/host.ts", client: "./src/client.tsx" },
          minAppVersion: appVersion,
          defaultEnabled: true,
          paths: [route],
          permissions: ["data:read"],
        },
        peerDependencies: { react: "^19" },
        devDependencies: { "@types/react": "^19", typescript: "^5" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
    ".gitignore": "dist\nnode_modules\n",
    "README.md": `# ${title}

A SpecDriven plugin: a host half that runs inside the server and a browser
half the server serves to the app. Both are plain ESM modules whose default
export is \`{ name, inject, apply(ctx, config) }\`.

- \`src/host.ts\` — registers routes on \`ctx.need("routes")\`, against the data
  folder through \`ctx.need("data")\`; every registration is an effect the app
  unwinds when the plugin is switched off.
- \`src/client.tsx\` — registers a tab on \`ctx.need("tabs")\`: an icon, the urls
  it owns, a Sidebar and a Pane. It imports \`react\` like any component; the
  app shares its own React with the bundle.

While the app runs on Bun (the dev server, the \`specdriven\` binary) it builds
this folder itself and rebuilds it as you edit. The desktop app loads
\`dist/\` only: run \`specdriven plugin build\` first.

    specdriven plugin link ${short === id ? "." : "."}
    specdriven plugin build
`,
    "src/host.ts": `// The host half: runs inside the SpecDriven server (or the desktop app's
// main process). Everything it registers is an effect, unwound when the
// plugin is switched off — its routes answer 404 from then on.

type Disposer = () => void | Promise<void>;
type Handler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

/** The services this plugin asks for (see src/plugins/host/services.ts in the app). */
interface Ctx {
  need(key: "routes"): { add(method: string, pattern: string, handler: Handler): Disposer };
  need(key: "data"): {
    withDir(handler: (dir: string, req: Request, params: Record<string, string>) => Response | Promise<Response>): Handler;
  };
  effect(run: () => Disposer): Disposer;
}

export default {
  name: ${JSON.stringify(id)},
  inject: ["routes", "data"],
  apply(ctx: Ctx) {
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    ctx.effect(() =>
      routes.add(
        "GET",
        ${JSON.stringify(api)},
        data.withDir(async (dir) => Response.json({ plugin: ${JSON.stringify(id)}, dataDir: dir })),
      ),
    );
  },
};
`,
    "src/client.tsx": `// The browser half: registers a tab. \`react\` here is the app's own — the
// bundle is built over it — so hooks, context and the design tokens are
// shared. Icons: bundle what you need (e.g. from lucide-react) or draw one.

import { forwardRef, useEffect, useState } from "react";

type Disposer = () => void | Promise<void>;
interface View {}
/** What the app hands the tab's components (src/plugins/client/tabs.ts TabApp). */
interface TabApp {
  goHome(): void;
}
interface Ctx {
  need(key: "tabs"): { add(tab: unknown): Disposer };
  effect(run: () => Disposer): Disposer;
}

const Icon = forwardRef<SVGSVGElement, { size?: number | string; className?: string }>(
  ({ size = 16, ...props }, ref) => (
    <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
    </svg>
  ),
);

function Sidebar() {
  return <p style={{ padding: "0.75rem", color: "var(--text-2)" }}>${title}</p>;
}

function Pane({ app }: { view: View; app: TabApp; navigate: (view: View) => void }) {
  const [reply, setReply] = useState<string>("…");
  useEffect(() => {
    fetch(${JSON.stringify(api)})
      .then((r) => r.json())
      .then((body) => setReply(JSON.stringify(body)))
      .catch((e) => setReply(String(e)));
  }, []);
  return (
    <div style={{ padding: "1rem" }}>
      <h1>${title}</h1>
      <p>The host half says: <code>{reply}</code></p>
      <button type="button" onClick={app.goHome}>Home</button>
    </div>
  );
}

export default {
  name: ${JSON.stringify(id)},
  inject: ["tabs"],
  apply(ctx: Ctx) {
    const tabs = ctx.need("tabs");
    ctx.effect(() =>
      tabs.add({
        id: ${JSON.stringify(id)},
        title: ${JSON.stringify(title)},
        icon: Icon,
        order: 100,
        route: {
          match: (pathname: string) => (pathname === ${JSON.stringify(route)} ? {} : null),
          path: () => ${JSON.stringify(route)},
          key: () => ${JSON.stringify(short)},
          title: () => ${JSON.stringify(title)},
          home: {},
        },
        Sidebar,
        Pane,
      }),
    );
  },
};
`,
  };
}

// ---- build ------------------------------------------------------------------

async function build(args: string[], io: CliIo): Promise<number> {
  const dir = resolve(args[0] ?? ".");
  if (!canBuild()) {
    io.error("Building needs Bun: run this with the specdriven binary or `bun src/index.ts plugin build`.");
    return 1;
  }
  const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown;
  const manifest = parsePackageManifest(raw, appVersion);
  if (!manifest.src?.host && !manifest.src?.client) {
    io.error(`${join(dir, "package.json")} names no "src" halves to build.`);
    return 1;
  }
  const outDir = join(dir, "dist");
  await mkdir(outDir, { recursive: true });
  if (manifest.src.host) {
    await buildHost(join(dir, manifest.src.host), outDir);
    io.log(`  ✓ dist/host.js`);
  }
  if (manifest.src.client) {
    await buildClient(join(dir, manifest.src.client), outDir);
    io.log(`  ✓ dist/client.js`);
  }
  for (const [key, expected] of [
    ["host", manifest.src.host ? "./dist/host.js" : null],
    ["client", manifest.src.client ? "./dist/client.js" : null],
  ] as const) {
    const declared = manifest[key];
    if (expected && declared && resolve(dir, declared) !== resolve(dir, expected)) {
      io.log(`  ! the manifest's "${key}" is ${declared}; the build wrote ${expected}`);
    }
  }
  return 0;
}

// ---- link -------------------------------------------------------------------

async function link(args: string[], io: CliIo): Promise<number> {
  const dir = resolve(args[0] ?? ".");
  const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown;
  const manifest = parsePackageManifest(raw, appVersion);
  const root = getAppRoot();
  const state = (await readState(root)) as Record<string, unknown>;
  const section =
    state[PROFILE_KEY] && typeof state[PROFILE_KEY] === "object"
      ? (state[PROFILE_KEY] as Record<string, unknown>)
      : {};
  const sources = Array.isArray(section.sources) ? [...section.sources] : [];
  const paths = sources.map((s) => (typeof s === "string" ? s : (s as { path?: string })?.path));
  if (!paths.includes(dir)) sources.push({ path: dir });
  state[PROFILE_KEY] = { ...section, sources };
  await writeState(state, root);
  io.log(`Linked ${manifest.id} (${dir}) in this machine's profile.`);
  io.log("The app loads it on its next start, or as soon as it re-reads its settings.");
  return 0;
}
