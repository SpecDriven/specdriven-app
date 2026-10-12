// The gateway's own pages (src/gateway/pages/*.html): sign in, sign up,
// forgotten password, choosing a password from an emailed link, the account
// page with the GitHub token, agent keys and password, and the admin page
// with the allowed emails and the users' roles.
// Plain DOM, no framework; every value from the server goes in as text.

type Json = Record<string, unknown>;

async function call(path: string, method = "GET", body?: Json): Promise<{ ok: boolean; status: number; data: Json }> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  return { ok: res.ok, status: res.status, data };
}

function el<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function show(node: Element | null, text: string | null): void {
  if (!(node instanceof HTMLElement)) return;
  node.textContent = text ?? "";
  node.hidden = !text;
}

/** Wire a form: collect its fields, run `submit`, show its error or notice. */
function onSubmit(form: HTMLFormElement, submit: (fields: Record<string, string>) => Promise<string | void>): void {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    show(form.querySelector(".error"), null);
    show(form.querySelector(".notice"), null);
    if (button) button.disabled = true;
    try {
      const fields = Object.fromEntries(
        [...new FormData(form).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]),
      );
      const error = await submit(fields);
      if (error) show(form.querySelector(".error"), error);
    } catch {
      show(form.querySelector(".error"), "Something went wrong — check your connection and try again");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function errorOf(data: Json): string {
  return typeof data.error === "string" ? data.error : "Something went wrong — try again";
}

/** Where to go after signing in: a same-site path from ?next=, else the app. */
function nextPath(): string {
  const next = new URLSearchParams(location.search).get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** The pages that answer "check your email" whatever the address. */
function emailRequestPage(path: string, sentText: string): void {
  const form = el<HTMLFormElement>("#form");
  const prefill = new URLSearchParams(location.search).get("email");
  if (prefill) el<HTMLInputElement>('input[name="email"]', form).value = prefill;
  onSubmit(form, async ({ email }) => {
    const { ok, data } = await call(path, "POST", { email });
    if (!ok) return errorOf(data);
    form.hidden = true;
    show(document.querySelector(".notice"), sentText);
  });
}

const pages: Record<string, () => void> = {
  login() {
    onSubmit(el<HTMLFormElement>("#form"), async ({ email, password }) => {
      const { ok, data } = await call("/auth/login", "POST", { email, password });
      if (!ok) return errorOf(data);
      location.assign(nextPath());
    });
  },

  signup() {
    emailRequestPage(
      "/auth/signup",
      "Check your email. If this address may join, a link to choose your password is on its way; it works for 24 hours.",
    );
  },

  forgot() {
    emailRequestPage(
      "/auth/forgot",
      "Check your email. If an account uses this address, a reset link is on its way; it works for 30 minutes.",
    );
  },

  "set-password"() {
    // The token rides in the fragment, which never reaches a server or a
    // Referer header; take it out of the address bar at once.
    const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
    history.replaceState(null, "", location.pathname);
    const form = el<HTMLFormElement>("#form");
    if (!token) {
      show(form.querySelector(".error"), "This link is incomplete — open the link from your email again.");
    }
    onSubmit(form, async ({ password, confirm }) => {
      if (password !== confirm) return "The two passwords differ";
      const { ok, data } = await call("/auth/set-password", "POST", { token, password });
      if (!ok) return errorOf(data);
      location.assign("/");
    });
  },

  async account() {
    const me = await call("/auth/me");
    if (me.status === 401) {
      location.assign("/login?next=/account");
      return;
    }
    el("#sign-out").addEventListener("click", async () => {
      await call("/auth/logout", "POST");
      location.assign("/login");
    });
    render(me.data);

    async function refresh() {
      const again = await call("/auth/me");
      if (again.ok) render(again.data);
    }

    const githubForm = el<HTMLFormElement>("#github-form");
    onSubmit(githubForm, async ({ token }) => {
      const { ok, data } = await call("/auth/secrets/github", "PUT", { token: token?.trim() });
      if (!ok) return errorOf(data);
      githubForm.reset();
      await refresh();
    });
    el("#github-remove").addEventListener("click", async () => {
      if (!confirm("Remove the GitHub token? SpecDriven stops syncing your specs until you add one again.")) return;
      await call("/auth/secrets/github", "DELETE");
      await refresh();
    });

    const keyForm = el<HTMLFormElement>("#key-form");
    onSubmit(keyForm, async ({ name, value }) => {
      const { ok, data } = await call(`/auth/secrets/agent-keys/${encodeURIComponent(name?.trim() ?? "")}`, "PUT", {
        value: value?.trim(),
      });
      if (!ok) return errorOf(data);
      keyForm.reset();
      await refresh();
    });

    const passwordForm = el<HTMLFormElement>("#password-form");
    onSubmit(passwordForm, async ({ current, password }) => {
      const { ok, data } = await call("/auth/change-password", "POST", { current, password });
      if (!ok) return errorOf(data);
      passwordForm.reset();
      show(passwordForm.querySelector(".notice"), "Password changed. Your other sign-ins were ended.");
    });

    function render(data: Json) {
      el("#email").textContent = String(data.email ?? "");
      el("#admin-link").hidden = data.role !== "admin";
      const github = data.github as { login?: string; hint?: string } | null;
      el("#github-status").textContent = github
        ? `Connected as ${github.login} (token …${github.hint}).`
        : "No token yet.";
      el("#github-remove").hidden = !github;
      const list = el("#keys");
      list.replaceChildren();
      const keys = (data.agentKeys as { name: string; hint: string; updatedAt: number }[]) ?? [];
      if (!keys.length) {
        const li = document.createElement("li");
        li.className = "hint";
        li.textContent = "No keys yet.";
        list.append(li);
      }
      for (const key of keys) {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${key.name} — …${key.hint} · saved ${new Date(key.updatedAt).toLocaleDateString()}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "link";
        remove.textContent = "Remove";
        remove.addEventListener("click", async () => {
          if (!confirm(`Remove the key "${key.name}"?`)) return;
          await call(`/auth/secrets/agent-keys/${encodeURIComponent(key.name)}`, "DELETE");
          await refresh();
        });
        li.append(label, remove);
        list.append(li);
      }
    }
  },

  async admin() {
    const first = await call("/auth/admin");
    if (first.status === 401) {
      location.assign("/login?next=/admin");
      return;
    }
    render(first.data);

    async function refresh() {
      const again = await call("/auth/admin");
      if (again.ok) render(again.data);
    }

    const allowedForm = el<HTMLFormElement>("#allowed-form");
    onSubmit(allowedForm, async ({ email, invite }) => {
      const entry = email?.trim() ?? "";
      const { ok, data } = await call("/auth/admin/allowed", "POST", { email: entry, invite: invite === "on" });
      if (!ok) return errorOf(data);
      allowedForm.reset();
      const invited = invite === "on" && !entry.startsWith("@");
      const notice = invited ? `Allowed ${entry}, and invited it if it has no account yet.` : `Allowed ${entry}.`;
      show(allowedForm.querySelector(".notice"), notice);
      await refresh();
    });

    function render(data: Json) {
      const allowed = (data.allowed as { email: string; addedBy: string | null; createdAt: number }[]) ?? [];
      const allowedList = el("#allowed");
      allowedList.replaceChildren();
      if (!allowed.length) allowedList.append(hintItem("Nobody yet: no one can sign up."));
      for (const entry of allowed) {
        const by = entry.addedBy ? ` by ${entry.addedBy}` : "";
        const text = `${entry.email} — added${by} · ${new Date(entry.createdAt).toLocaleDateString()}`;
        allowedList.append(
          item(text, "Remove", async () => {
            if (!confirm(`Take ${entry.email} off the allowed emails?`)) return;
            await call(`/auth/admin/allowed/${encodeURIComponent(entry.email)}`, "DELETE");
            await refresh();
          }),
        );
      }

      const users = (data.users as { id: string; email: string; role: string; hasPassword: boolean }[]) ?? [];
      const userList = el("#users");
      userList.replaceChildren();
      for (const user of users) {
        const you = user.id === data.you ? " (you)" : "";
        const pending = user.hasPassword ? "" : " · has not set a password yet";
        const next = user.role === "admin" ? "user" : "admin";
        userList.append(
          item(`${user.email}${you} — ${user.role}${pending}`, `Make ${next}`, async () => {
            show(el("#users-error"), null);
            const { ok, data } = await call(`/auth/admin/users/${encodeURIComponent(user.id)}/role`, "PUT", {
              role: next,
            });
            if (!ok) show(el("#users-error"), errorOf(data));
            await refresh();
          }),
        );
      }
    }

    function hintItem(text: string): HTMLLIElement {
      const li = document.createElement("li");
      li.className = "hint";
      li.textContent = text;
      return li;
    }

    function item(text: string, action: string, onClick: () => Promise<void>): HTMLLIElement {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = text;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link";
      button.textContent = action;
      button.addEventListener("click", () => void onClick());
      li.append(label, button);
      return li;
    }
  },
};

void pages[document.body.dataset.page ?? ""]?.();
