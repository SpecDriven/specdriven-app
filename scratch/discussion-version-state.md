Got it — `archived` is a *location* change, not just a marker: the scenario moves out of the main feature file into a parallel file under `archived/`. The header grammar from the last round is unchanged; what this refines is the state model, the file layout, and — most importantly — how references resolve, because archival must never break an existing test link. Here's the updated model.

## File layout

```
data-repo/
  quote-policy.feature              # proposed / published / deleted scenarios
  archived/
    quote-policy.feature            # archived scenarios only — same Feature: name
```

The archive counterpart has the same basename and the same `Feature:` header, and is created on first archival; scenarios are appended in archival order. Main file and archive file are two sections of one logical feature — hot and cold.

## State model

| State | Location | Meaning | Body |
|---|---|---|---|
| `proposed` *(default)* | main file | Work in progress; auto-saved and synced | editable |
| `published` | main file | Current authoritative version | frozen |
| `deleted` | main file | Retracted — the behavior no longer exists; visible tombstone | frozen |
| `archived` | `archived/<file>` | Superseded — a newer version of this name was published | frozen |

```
proposed ──publish (PM)──▶ published ──successor published──▶ archived   (moves to archived/<file>)
                                └───────retract (PM)────────▶ deleted    (tombstone stays in main)
```

- The two terminal states split by *why* the scenario is no longer current: `archived` = replaced (look for the successor version), `deleted` = gone (no successor exists). Retiring a feature line without a replacement is therefore a delete, and archival happens automatically as part of publishing the successor — there's no separate "archive" action.
- `proposed` scenarios are still just edited or physically removed; they never reach either terminal state.
- Publishing `name v(N+1)` is now a **two-file operation in one commit**: mark `v(N+1)` `[published]` in the main file, move `vN` to the archive file as `[archived]`. The pull/merge conflict flow on publish has to cover both files.

## Reference resolution — the critical invariant

A spec-ref is minted against the main file and **never changes**: `quote-policy.feature#Basic Quote v1` stays valid for the lifetime of the repo. Resolution checks the main file first, then `archived/quote-policy.feature`. The archive path is storage, not identity — if archival rewrote refs to `archived/quote-policy.feature#...`, every `@Spec` annotation pointing at a superseded scenario would break at exactly the moment the agents need it to resolve (to tell the developer "your test pins v1, current is v2"). Tooling and the JUnit annotation always use the main-file name.

## Updated validation rules

1. A `Scenario:` line that doesn't fully match the grammar is a parse error with a line number — never body text. *(unchanged)*
2. `(name, version)` is unique across the main file **and its archive counterpart together** — they're one logical namespace. Per name: at most one `published`, at most one `proposed` (lint).
3. Forward-only, frozen-body — now spanning both files: every `(name, version)` that has reached `published` must continue to exist in either the main file (as `published` or `deleted`) or the archive file (as `archived`), with an identical body. A save or publish that would make it vanish from both, edit its body, or move its state backward is rejected.
4. Unknown or miscased state words are parse errors. *(unchanged)*
5. Name charset rules and the trailing-`v<digits>` prohibition. *(unchanged)*
6. **Location invariant (new):** `[archived]` appears only in `archived/*.feature`, and archive files contain *only* `[archived]` scenarios. An `[archived]` header in a main file — or a `[published]` one in an archive file — is a validation error. The marker is technically redundant with location, but keeping it mandatory means every file is self-describing and a mis-copied scenario is caught by validation instead of silently changing state.

Implementation-wise this touches a bit more than before: feature listing must skip `archived/` (the current non-recursive `readdir` already does), publish gains the move step, and the immutability assertion reads both files. One thing this model deliberately does *not* do is sweep old `deleted` tombstones out of the main file — that would blur "archive = superseded". If tombstone clutter becomes a real problem later, that's the one place I'd revisit.

If this now matches your intent, I'll write the consolidated version up as `specs/scenario-header.spec.md` — grammar, state model, layout, and validation rules in one place — so it can drive the parser and publish-flow changes.
