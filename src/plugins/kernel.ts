// The plugin kernel (roadmap/plugin-architecture.md, specs/app/plugins
// .feature.md): a small Cordis-shaped context shared unchanged by the Bun
// server, the Electron main process and the browser. A plugin is
// `{ name, inject, Config, apply(ctx, config) }`; it contributes services
// (`ctx.provide`), typed events (`ctx.on` / `emit` / `serial` / `parallel` /
// `bail`) and effects (`ctx.effect`), and every one of those is reversible:
// disposing the plugin's scope unwinds them in reverse order. That is what
// lets a module switch mount and unmount a tab without a restart.
//
// No dependency on purpose: the `cordis` package fits semantically but brings
// its own loader, schema library and fork semantics, and this has to run in
// three runtimes inside a `--compile` binary. The vocabulary is Cordis's so a
// later swap is mechanical.

export type Disposer = () => void | Promise<void>;

/** Declaration-merged by whoever provides a service (`ctx.<key>`). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Services {}

/** Declaration-merged by whoever emits an event; the listener type drives
    the typing of `emit`, `serial`, `parallel` and `bail`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Events {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => any;
type ServiceKey = keyof Services & string;
type EventKey = keyof Events & string;
type Args<K extends EventKey> = Events[K] extends (...args: infer A) => unknown ? A : never;
type Result<K extends EventKey> = Events[K] extends (...args: never[]) => infer R ? Awaited<R> : never;

export interface Plugin<C extends Context = Context, Cfg = unknown> {
  /** Unique; names the scope in logs and in Settings → Plugins. */
  name: string;
  /** Services that must exist before `apply` runs; the scope waits for them. */
  inject?: readonly ServiceKey[];
  /** Validates and defaults the entry's config; a throw refuses the load. */
  Config?: { parse(raw: unknown): Cfg };
  apply(ctx: C, config: Cfg): void | Promise<void>;
}

export type ScopeStatus = "pending" | "active" | "disposed";

/** One mounted (or waiting) plugin: its effects, its children, its state. */
export interface Scope {
  readonly name: string;
  readonly parent: Scope | null;
  /** pending until every inject exists; active after apply; disposed after unwind. */
  readonly status: ScopeStatus;
  /** Why apply failed, when it did; the scope is disposed then. */
  readonly error?: Error;
  /** Resolves once the first `apply` has run — or failed; never rejects. */
  readonly ready: Promise<void>;
  /** Children first, effects last-in-first-out. Idempotent. */
  dispose(): Promise<void>;
}

interface Entry {
  plugin: Plugin<Context, unknown>;
  config: unknown;
  scope: ScopeImpl;
  ctx: Context;
}

class ScopeImpl implements Scope {
  status: ScopeStatus = "pending";
  error?: Error;
  readonly effects: Disposer[] = [];
  readonly children: ScopeImpl[] = [];
  readonly ready: Promise<void>;
  resolveReady!: () => void;
  /** The plugin entry this scope mounts; the root has none. */
  entry: Entry | null = null;

  constructor(
    readonly name: string,
    readonly parent: ScopeImpl | null,
    private readonly root: Context,
  ) {
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** Unwind children, then effects, keeping the scope itself around. */
  async unwind(): Promise<void> {
    for (const child of this.children.splice(0).reverse()) await child.dispose();
    for (const effect of this.effects.splice(0).reverse()) {
      try {
        await effect();
      } catch (e) {
        report(`disposing ${this.name}`, e);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.status === "disposed") return;
    this.status = "disposed";
    if (this.entry) this.root.forget(this.entry);
    await this.unwind();
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    // A scope disposed before it ever mounted still resolves whoever waits.
    this.resolveReady();
  }
}

function report(what: string, e: unknown): void {
  console.error(`[plugins] ${what}: ${(e as Error)?.message ?? String(e)}`);
}

export class Context {
  readonly root: Context;
  readonly scope: Scope;
  private readonly impl: ScopeImpl;
  // Root-only state, reached through `root` from every child.
  private readonly services = new Map<string, unknown>();
  private readonly listeners = new Map<string, { listener: Listener; scope: ScopeImpl }[]>();
  private readonly entries = new Set<Entry>();
  private readonly readyQueue: (() => void | Promise<void>)[] = [];
  private started = false;

  constructor(parent?: Context, scope?: ScopeImpl) {
    this.root = parent ? parent.root : this;
    this.impl = scope ?? new ScopeImpl("root", null, this);
    this.scope = this.impl;
  }

  // ---- services -----------------------------------------------------------

  /** Claim `ctx.<key>`; reversible, and a duplicate claim is a bug. */
  provide<K extends ServiceKey>(key: K, value: Services[K]): Disposer {
    const root = this.root;
    if (root.services.has(key)) throw new Error(`service "${key}" is already provided`);
    return this.effect(() => {
      root.services.set(key, value);
      root.reconcile();
      return async () => {
        root.services.delete(key);
        // Dependents go back to waiting, their effects unwound, and come
        // back on their own when the service is provided again.
        for (const entry of root.entries) {
          if (entry.scope.status === "active" && entry.plugin.inject?.includes(key)) {
            await entry.scope.unwind();
            entry.scope.status = "pending";
          }
        }
      };
    });
  }

  get<K extends ServiceKey>(key: K): Services[K] | undefined {
    return this.root.services.get(key) as Services[K] | undefined;
  }

  need<K extends ServiceKey>(key: K): Services[K] {
    const value = this.root.services.get(key);
    if (value === undefined) throw new Error(`service "${key}" is not provided`);
    return value as Services[K];
  }

  // ---- effects ------------------------------------------------------------

  /** Run a side effect now and unwind it when this scope is disposed. */
  effect(run: () => Disposer): Disposer {
    const dispose = run();
    let done = false;
    const once: Disposer = async () => {
      if (done) return;
      done = true;
      const i = this.impl.effects.indexOf(once);
      if (i >= 0) this.impl.effects.splice(i, 1);
      await dispose();
    };
    this.impl.effects.push(once);
    return once;
  }

  // ---- events -------------------------------------------------------------

  on<K extends EventKey>(event: K, listener: Events[K] & Listener): Disposer {
    const root = this.root;
    return this.effect(() => {
      const row = { listener, scope: this.impl };
      const rows = root.listeners.get(event) ?? [];
      rows.push(row);
      root.listeners.set(event, rows);
      return () => {
        const current = root.listeners.get(event);
        if (!current) return;
        const i = current.indexOf(row);
        if (i >= 0) current.splice(i, 1);
      };
    });
  }

  private rows(event: string): Listener[] {
    return (this.root.listeners.get(event) ?? []).map((row) => row.listener);
  }

  /** Fire and forget: every listener, in order; an error is logged, never thrown. */
  emit<K extends EventKey>(event: K, ...args: Args<K>): void {
    for (const listener of this.rows(event)) {
      try {
        const result = listener(...args);
        if (result instanceof Promise) result.catch((e) => report(event, e));
      } catch (e) {
        report(event, e);
      }
    }
  }

  /** Every listener awaited in registration order. */
  async serial<K extends EventKey>(event: K, ...args: Args<K>): Promise<void> {
    for (const listener of this.rows(event)) await listener(...args);
  }

  /** Every listener awaited concurrently. */
  async parallel<K extends EventKey>(event: K, ...args: Args<K>): Promise<void> {
    await Promise.all(this.rows(event).map((listener) => listener(...args)));
  }

  /** The first listener to answer something other than undefined wins. */
  async bail<K extends EventKey>(event: K, ...args: Args<K>): Promise<Result<K> | undefined> {
    for (const listener of this.rows(event)) {
      const result = await listener(...args);
      if (result !== undefined) return result as Result<K>;
    }
    return undefined;
  }

  // ---- plugins ------------------------------------------------------------

  /** Mount a plugin as a child scope; it applies once its injects exist. */
  plugin<Cfg>(plugin: Plugin<this, Cfg>, config?: unknown): Scope {
    const root = this.root;
    const scope = new ScopeImpl(plugin.name, this.impl, root);
    const entry: Entry = {
      plugin: plugin as unknown as Plugin<Context, unknown>,
      config: undefined,
      scope,
      ctx: new Context(this, scope),
    };
    scope.entry = entry;
    this.impl.children.push(scope);
    try {
      entry.config = plugin.Config ? plugin.Config.parse(config) : config;
    } catch (e) {
      scope.error = e as Error;
      void scope.dispose();
      return scope;
    }
    root.entries.add(entry);
    root.reconcile();
    return scope;
  }

  /** Drop a disposed entry; called by its scope. */
  forget(entry: Entry): void {
    this.root.entries.delete(entry);
  }

  /** Mount every waiting entry whose injects are all provided. */
  private reconcile(): void {
    const root = this.root;
    for (const entry of root.entries) {
      if (entry.scope.status !== "pending") continue;
      const missing = (entry.plugin.inject ?? []).some((key) => !root.services.has(key));
      if (missing) continue;
      entry.scope.status = "active";
      void root.mount(entry);
    }
  }

  private async mount(entry: Entry): Promise<void> {
    const { scope } = entry;
    try {
      await entry.plugin.apply(entry.ctx, entry.config);
    } catch (e) {
      scope.error = e as Error;
      report(`mounting ${scope.name}`, e);
      await scope.dispose();
    } finally {
      scope.resolveReady();
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Run once the root has started (and this scope's injects were met). */
  ready(fn: () => void | Promise<void>): Disposer {
    const root = this.root;
    if (root.started) {
      void Promise.resolve(fn()).catch((e) => report("ready", e));
      return () => {};
    }
    root.readyQueue.push(fn);
    return () => {
      const i = root.readyQueue.indexOf(fn);
      if (i >= 0) root.readyQueue.splice(i, 1);
    };
  }

  async start(): Promise<void> {
    const root = this.root;
    root.started = true;
    for (const fn of root.readyQueue.splice(0)) {
      try {
        await fn();
      } catch (e) {
        report("ready", e);
      }
    }
  }

  /** Dispose every scope beneath the root; the root itself stays usable. */
  async stop(): Promise<void> {
    const root = this.root;
    for (const child of root.impl.children.splice(0).reverse()) await child.dispose();
    for (const effect of root.impl.effects.splice(0).reverse()) await effect();
    root.started = false;
  }
}
