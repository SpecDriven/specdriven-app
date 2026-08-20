# Starting a session in Claude Code Desktop programmatically

Verified on this machine against CLI 2.1.221 and Claude.app 1.32885.1 (read out of
the shipped bundles — see caveats).

## 1. Headless session (no desktop UI)

What `capturing-claude-session-id.md` covers: `claude -p --session-id <uuid>`.
Full control over prompt, model, permission mode, output format — but the session
lives in your process, not in the app.

## 2. Open an actual session in Claude Code Desktop

The desktop app registers the `claude://` URL scheme (`/Applications/Claude.app`,
`CFBundleURLTypes`), and its URL router has a `code` host with a `/new` route:

```bash
open "claude://code/new?q=Review%20the%20auth%20spec&folder=/Users/me/dev/personal/SpecDriven/specdriven_app"
```

From the router source in `app.asar`: host `code`, path `/new`, params `q`
(alias `prompt`, truncated at a max length), plus repeatable `folder` and `file`.
Supplying `folder`/`file` marks the link `src=external`, which is what triggers the
trusted-folder check. There is an equivalent `claude://cowork/new?q=&folder=&file=`
for Cowork.

## 3. The combination that probably fits the roadmap item

Create the session programmatically with the CLI (so you pick the UUID, model, and
prompt), then hand it to the desktop UI — the router has a `resume` host that calls
`importCliSession`:

```bash
SID=$(uuidgen | tr 'A-Z' 'a-z'); claude -p "draft scenarios for spec X" --session-id "$SID"; open "claude://resume?session=$SID"
```

That gives a fully-configured session the user can then continue interactively in
the desktop app.

## Related

`~/Applications/Claude Code URL Handler.app` registers `claude-cli://` and is just a
symlink to the `claude` binary — that's the terminal-side handler, auto-registered on
install (disable with the `disableDeepLinkRegistration` setting).

## Caveats

- None of these deep links are publicly documented, so they are version-coupled;
  they were read out of the shipped bundles, not from docs.
- The `claude://code/<session-path>` variant (as opposed to `/new`) is behind a
  feature gate; `/new` and `resume` are not.
- An `authentication.disableDeepLinks` setting disables all of them.
- Unverified: whether `q` auto-sends the prompt or only prefills the composer.

## Naming the session

Short answer: `--name` does **not** survive the `claude://resume` import. Verified
end to end on 2026-08-20.

`claude -p --session-id "$SID" --name "Spec Session Demo"` does persist the name —
the CLI writes it as the first line of the transcript:

```json
{"type":"custom-title","customTitle":"Spec Session Demo","sessionId":"13213666-…"}
```

But after `open "claude://resume?session=$SID"` the session shows up untitled in
Desktop. The desktop's transcript metadata reader parses `custom-title` (it returns
`{title, permissionMode, model}`), yet `importCliSession` — the function behind the
`resume` deep link — spreads only `permissionMode`, `model`, and the chrome
permission mode into the new session record. `title` is read and discarded.

Asymmetry worth knowing: the app's *other* CLI-import path (its "recover CLI
sessions" scan, used by the in-app importer) does set `title: l.title` with
`titleSource: "auto"`. The name survives there, just not via the deep link.

### Workarounds, best first

1. **Rename right after import.** The desktop session id is deterministic —
   `local_` + your UUID — so it is known before the deep link fires. Any Claude
   session running in Desktop can rename another by id:
   `set_session_title(session_id="local_$SID", title="…")`. The catch: that tool is
   an in-app MCP server bundled in Claude.app, reachable from a session, not from an
   external process. Fine if the app already drives a Claude session.
2. **Have the session name itself.** Put the instruction in the seeded prompt
   (`…&q=First set this session's title to "Spec 47: auth scenarios", then …`).
   Works with `claude://code/new` too, which otherwise has no title param — its only
   params are `q`/`prompt`, `folder`, `file`.
3. **Do nothing.** Once the imported session takes a turn in Desktop it gets an
   auto-generated title (`titleSource: "auto"`) — decent, just not yours.
