// The plugin kernel (roadmap/plugin-architecture.md): plugins wait for the
// services they inject, every registration unwinds on dispose, and a plugin
// that fails fails alone.

import { expect, test } from "bun:test";
import { Context, type Plugin } from "../src/plugins/kernel";

declare module "../src/plugins/kernel" {
  interface Services {
    greeter: { greet(name: string): string };
    counter: { n: number };
  }
  interface Events {
    "kernel-test/ping": (n: number) => void;
    "kernel-test/ask": (q: string) => string | undefined | Promise<string | undefined>;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("effects unwind last-in-first-out, and only once", async () => {
  const ctx = new Context();
  const order: string[] = [];
  const scope = ctx.plugin({
    name: "p",
    apply(c) {
      c.effect(() => () => void order.push("first"));
      const second = c.effect(() => () => void order.push("second"));
      c.effect(() => () => void order.push("third"));
      void second();
      void second();
    },
  });
  await scope.ready;
  expect(order).toEqual(["second"]);
  await scope.dispose();
  expect(order).toEqual(["second", "third", "first"]);
  expect(scope.status).toBe("disposed");
  await scope.dispose();
  expect(order).toEqual(["second", "third", "first"]);
});

test("a plugin waits for its injects and unmounts when one goes away", async () => {
  const ctx = new Context();
  const log: string[] = [];
  const consumer: Plugin = {
    name: "consumer",
    inject: ["greeter"],
    apply(c) {
      log.push(c.need("greeter").greet("world"));
      c.effect(() => () => void log.push("bye"));
    },
  };
  const scope = ctx.plugin(consumer);
  await tick();
  expect(scope.status).toBe("pending");
  expect(log).toEqual([]);

  const provider = ctx.plugin({
    name: "provider",
    apply(c) {
      c.provide("greeter", { greet: (name) => `hello ${name}` });
    },
  });
  await provider.ready;
  await scope.ready;
  expect(scope.status).toBe("active");
  expect(log).toEqual(["hello world"]);

  // The provider leaves: the consumer's effects unwind and it waits again.
  await provider.dispose();
  expect(scope.status).toBe("pending");
  expect(log).toEqual(["hello world", "bye"]);

  // And comes back when the service does.
  ctx.plugin({
    name: "provider2",
    apply(c) {
      c.provide("greeter", { greet: (name) => `hi ${name}` });
    },
  });
  await tick();
  expect(scope.status).toBe("active");
  expect(log).toEqual(["hello world", "bye", "hi world"]);
});

test("a duplicate service claim is refused", () => {
  const ctx = new Context();
  ctx.provide("counter", { n: 1 });
  expect(() => ctx.provide("counter", { n: 2 })).toThrow('service "counter" is already provided');
  expect(() => ctx.need("greeter")).toThrow('service "greeter" is not provided');
});

test("events: emit isolates errors, serial keeps order, bail stops at the first answer", async () => {
  const ctx = new Context();
  const seen: number[] = [];
  const a = ctx.plugin({
    name: "a",
    apply(c) {
      c.on("kernel-test/ping", () => {
        throw new Error("boom");
      });
      c.on("kernel-test/ping", (n) => {
        seen.push(n);
      });
      c.on("kernel-test/ask", () => undefined);
      c.on("kernel-test/ask", async (q) => `${q}?`);
      c.on("kernel-test/ask", () => "never");
    },
  });
  await a.ready;
  const quiet = console.error;
  console.error = () => {};
  try {
    ctx.emit("kernel-test/ping", 1);
  } finally {
    console.error = quiet;
  }
  expect(seen).toEqual([1]);
  expect(await ctx.bail("kernel-test/ask", "why")).toBe("why?");
  // serial propagates: the throwing listener stops the chain.
  await expect(ctx.serial("kernel-test/ping", 2)).rejects.toThrow("boom");
  expect(seen).toEqual([1]);
  await a.dispose();
  ctx.emit("kernel-test/ping", 3);
  expect(seen).toEqual([1]);
  expect(await ctx.bail("kernel-test/ask", "again")).toBeUndefined();
});

test("a plugin that throws in apply fails alone, its partial effects unwound", async () => {
  const ctx = new Context();
  const log: string[] = [];
  const quiet = console.error;
  console.error = () => {};
  let bad;
  try {
    bad = ctx.plugin({
      name: "bad",
      apply(c) {
        c.effect(() => () => void log.push("bad unwound"));
        throw new Error("nope");
      },
    });
    await bad.ready;
  } finally {
    console.error = quiet;
  }
  const good = ctx.plugin({
    name: "good",
    apply(c) {
      c.provide("counter", { n: 1 });
    },
  });
  await good.ready;
  expect(bad.status).toBe("disposed");
  expect(bad.error?.message).toBe("nope");
  expect(log).toEqual(["bad unwound"]);
  expect(good.status).toBe("active");
  expect(ctx.get("counter")).toEqual({ n: 1 });
});

test("Config validates the entry, and a bad config refuses the load", async () => {
  const ctx = new Context();
  const got: unknown[] = [];
  const plugin: Plugin<Context, { size: number }> = {
    name: "sized",
    Config: {
      parse(raw) {
        const size = (raw as { size?: unknown })?.size ?? 3;
        if (typeof size !== "number") throw new Error("size must be a number");
        return { size };
      },
    },
    apply(_c, config) {
      got.push(config);
    },
  };
  await ctx.plugin(plugin).ready;
  await ctx.plugin(plugin, { size: 7 }).ready;
  const refused = ctx.plugin(plugin, { size: "big" });
  await refused.ready;
  expect(got).toEqual([{ size: 3 }, { size: 7 }]);
  expect(refused.status).toBe("disposed");
  expect(refused.error?.message).toBe("size must be a number");
});

test("stop disposes every scope and ready runs after start", async () => {
  const ctx = new Context();
  const log: string[] = [];
  const scope = ctx.plugin({
    name: "p",
    apply(c) {
      c.ready(() => {
        log.push("ready");
      });
      c.effect(() => () => void log.push("gone"));
    },
  });
  await scope.ready;
  expect(log).toEqual([]);
  await ctx.start();
  expect(log).toEqual(["ready"]);
  await ctx.stop();
  expect(log).toEqual(["ready", "gone"]);
  expect(scope.status).toBe("disposed");
});
