// The Images page (src/frontend/ImagesPage.tsx, specs/app/unused-images.
// feature.md [proposed]) driven in a borrowed DOM against a fake /api/images:
// the tabs with their counts, the unreferenced images as a thumbnail grid
// with a checkbox each, Select all → Delete asking first and sending the
// names, a refusal leaving the grid alone, a thumbnail opening its preview
// with where it is used, and the demo without a way to delete.
//
// The DOM is borrowed the way tests/dataPage.test.tsx borrows it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/images" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { ImagesPage, type StoredImage } from "../src/frontend/ImagesPage";
import type { ConfirmOptions } from "../src/frontend/ModalPrompts";

const FEATURE = "specs/billing/collect-premium.feature.md";

const image = (name: string, bytes: number, referencedBy: string[] = []): StoredImage => ({
  name,
  path: `/api/images/${name}`,
  bytes,
  referencedBy,
});

/** The handlers React gave an element. */
function reactProps(el: Element): Record<string, (e: unknown) => void> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key]!;
}

function click(el: Element) {
  reactProps(el).onClick!({ target: el, currentTarget: el, preventDefault() {} });
}

function check(el: Element) {
  reactProps(el).onChange!({ target: el, currentTarget: el });
}

type Call = { url: string; init?: RequestInit };

/** A fake server over a mutable list: GET lists it, DELETE drops names or refuses the referenced. */
function server(images: StoredImage[]) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url !== "/api/images") return Response.json({ error: `unexpected ${url}` }, { status: 500 });
    if (init?.method === "DELETE") {
      const { names } = JSON.parse(String(init.body)) as { names: string[] };
      const referenced = Object.fromEntries(
        images.filter((i) => names.includes(i.name) && i.referencedBy.length > 0).map((i) => [i.name, i.referencedBy]),
      );
      if (Object.keys(referenced).length > 0) {
        return Response.json({ error: `${Object.keys(referenced)[0]} is still referenced`, referenced }, { status: 409 });
      }
      for (const name of names) images.splice(images.findIndex((i) => i.name === name), 1);
      return Response.json({ deleted: names, message: "ok" });
    }
    return Response.json({ images: [...images] });
  };
  return { calls, fetcher };
}

async function mount(props: { fetcher: (url: string, init?: RequestInit) => Promise<Response>; confirm?: (o: ConfirmOptions) => Promise<boolean>; demo?: boolean }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const confirm = props.confirm ?? (async () => true);
  await act(async () => root.render(<ImagesPage onClose={() => {}} confirm={confirm} demo={props.demo} fetcher={props.fetcher} />));
  await flush();
  return { container, root };
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const tabs = (c: Element) => [...c.querySelectorAll('.app-page-tabs [role="tab"]')].map((t) => t.textContent);
const names = (c: Element) => [...c.querySelectorAll(".image-card .image-name")].map((n) => n.textContent);

describe("the page", () => {
  test("lists the unreferenced images first, selects them all and deletes them after asking", async () => {
    const images = [
      image("a-11111111.png", 2048, [FEATURE]),
      image("b-22222222.png", 1024),
      image("c-33333333.svg", 512, [FEATURE, "roadmap/q3.md"]),
      image("d-44444444.png", 4096),
    ];
    const { calls, fetcher } = server(images);
    const asked: ConfirmOptions[] = [];
    const { container } = await mount({
      fetcher,
      confirm: async (o) => {
        asked.push(o);
        return true;
      },
    });

    expect(tabs(container)).toEqual(["Unreferenced · 2", "All · 4"]);
    expect(names(container)).toEqual(["b-22222222.png", "d-44444444.png"]);
    expect(container.textContent).toContain("2 of 4 stored images are not referenced by any feature or page · 5.0 KB");
    expect([...container.querySelectorAll(".image-thumb img")].map((i) => i.getAttribute("src"))).toEqual([
      "/api/images/b-22222222.png",
      "/api/images/d-44444444.png",
    ]);

    const deleteButton = () => container.querySelector(".btn-danger-solid") as HTMLButtonElement;
    expect(deleteButton().disabled).toBe(true);

    const selectAll = [...container.querySelectorAll(".images-actions .btn")].find((b) => b.textContent === "Select all")!;
    await act(async () => click(selectAll));
    expect([...container.querySelectorAll(".image-check")].map((c) => (c as HTMLInputElement).checked)).toEqual([true, true]);
    expect(container.querySelectorAll(".image-card.selected").length).toBe(2);
    expect(deleteButton().textContent).toBe("Delete 2");

    // One unticked: only the other goes.
    await act(async () => check(container.querySelector('input[aria-label="Select b-22222222.png"]')!));
    expect(deleteButton().textContent).toBe("Delete 1");

    await act(async () => click(deleteButton()));
    await flush();
    expect(asked.length).toBe(1);
    expect(asked[0]!.title).toBe("Delete d-44444444.png?");
    expect(asked[0]!.danger).toBe(true);
    const del = calls.find((c) => c.init?.method === "DELETE")!;
    expect(JSON.parse(String(del.init!.body))).toEqual({ names: ["d-44444444.png"] });
    expect(names(container)).toEqual(["b-22222222.png"]);
    expect(tabs(container)).toEqual(["Unreferenced · 1", "All · 3"]);
  });

  test("a declined confirmation sends nothing; a refusal reloads and keeps the image", async () => {
    const images = [image("a-11111111.png", 10, [FEATURE]), image("b-22222222.png", 10)];
    const { calls, fetcher } = server(images);
    const { container } = await mount({ fetcher, confirm: async () => false });
    await act(async () => check(container.querySelector('input[aria-label="Select b-22222222.png"]')!));
    await act(async () => click(container.querySelector(".btn-danger-solid")!));
    await flush();
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    expect(names(container)).toEqual(["b-22222222.png"]);

    // A page that went stale: the server sees b in use by the time the
    // delete lands, refuses it, and the reloaded list says so.
    const { container: c2 } = await mount({ fetcher, confirm: async () => true });
    expect(names(c2)).toEqual(["b-22222222.png"]);
    images[1]!.referencedBy = ["roadmap/q3.md"];
    await act(async () => check(c2.querySelector('input[aria-label="Select b-22222222.png"]')!));
    await act(async () => click(c2.querySelector(".btn-danger-solid")!));
    await flush();
    await flush();
    expect(calls.filter((c) => c.init?.method === "DELETE").length).toBe(1);
    expect(tabs(c2)).toEqual(["Unreferenced · 0", "All · 2"]);
    expect(c2.textContent).toContain("Every stored image is referenced.");
  });

  test("a thumbnail opens the image with where it is used; the All tab shows every image", async () => {
    const images = [image("a-11111111.png", 2048, [FEATURE, "roadmap/q3.md"]), image("b-22222222.png", 1024)];
    const { fetcher } = server(images);
    const { container } = await mount({ fetcher });

    await act(async () => click(container.querySelector("#all-tab")!));
    await flush();
    expect(names(container)).toEqual(["a-11111111.png", "b-22222222.png"]);
    expect(container.querySelectorAll(".image-check").length).toBe(0);
    expect([...container.querySelectorAll(".image-size")].map((s) => s.textContent)).toEqual([
      "2.0 KB · used in 2 files",
      "1.0 KB · unreferenced",
    ]);

    expect(container.querySelector(".image-drawer")).toBeNull();
    await act(async () => click(container.querySelector('button[aria-label="Open a-11111111.png"]')!));
    const drawer = container.querySelector(".image-drawer")!;
    expect(drawer.querySelector(".image-full")!.getAttribute("src")).toBe("/api/images/a-11111111.png");
    expect([...drawer.querySelectorAll(".image-refs a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      [FEATURE, "/features/billing/collect-premium"],
    ]);
    expect([...drawer.querySelectorAll(".image-refs li")].map((li) => li.textContent)).toEqual([FEATURE, "roadmap/q3.md"]);
    expect(drawer.querySelector(".btn-danger")).toBeNull();

    await act(async () => click(container.querySelector('button[aria-label="Open b-22222222.png"]')!));
    const drawer2 = container.querySelector(".image-drawer")!;
    expect(drawer2.textContent).toContain("No file references it");
    expect(drawer2.querySelector(".btn-danger")).not.toBeNull();

    await act(async () => click(drawer2.querySelector('button[aria-label="Close preview"]')!));
    expect(container.querySelector(".image-drawer")).toBeNull();
  });

  test("the demo browses but cannot delete", async () => {
    const { fetcher } = server([image("b-22222222.png", 1024)]);
    const { container } = await mount({ fetcher, demo: true });
    expect(names(container)).toEqual(["b-22222222.png"]);
    expect(container.querySelector(".image-check")).toBeNull();
    expect(container.querySelector(".btn-danger-solid")).toBeNull();
    await act(async () => click(container.querySelector('button[aria-label="Open b-22222222.png"]')!));
    expect(container.querySelector(".image-drawer .btn-danger")).toBeNull();
  });

  test("nothing stored, and a server error, each say so", async () => {
    const { container } = await mount({ fetcher: server([]).fetcher });
    expect(container.textContent).toContain("No images are stored in the data repo.");
    const failing = async () => Response.json({ error: "data repo not configured" }, { status: 409 });
    const { container: c2 } = await mount({ fetcher: failing });
    expect(c2.querySelector('[role="alert"]')!.textContent).toBe("data repo not configured");
  });
});
