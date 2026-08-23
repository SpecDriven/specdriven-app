# Demonstration, Education, Marketing, Scripting

## What, Why, When, Who

In order to communicate and demonstrate the value and intended use of
SpecDriven, several approaches may be useful.

- Website: landing page for interested parties.
  - Statement of principles: "We believe that software engineering is valuable in the age of agentic coding; a specification driven workflow with small slices integrated with issue and feature tracking assists this." (etc.)
  - Picture of spec workflow, description of users, value to users and to software development orgs.
  - Call-outs to specific good eng practices; LK pattern language?
  - Sign-up: email address for updates (use mailing list manager and confirm before making a subscription active! - JM)
  - Blog / updates on progress / broad roadmap and milestones.
  - Link to demo app.

## Demonstration Content

A demo of the SpecDriven app may have different objectives and contents, depending on what we want to show off, and to whom.

A basic demo shows the workflow around editing specs, selecting specs, and launching coding sessions. The coding session is our circle of life to which a user or customer may attach project and task tracking, and session telemetry.

A more specific demo may focus on particular features, such as plug-ins, multiple editors in the specs, or privacy options for usage patterns.

A more specific demo may also highlight the value for different user profiles (personas) using SpecDriven.

A demo might also compare SpecDriven's approach and value with other development or tracking tools (OpenSpec, Linear?).

A demo related to plug-ins may also be framed around where SpecDriven fits in a larger development ecosystem, or an org's software development lifecycle.

It may be useful to have a specific vocabulary to follow around the items / entities within the SpecDriven app when presenting a demo.

## Demo App

Features:

- Runs the full app vs. a captive in-memory filesystem.
- Captive filesystem is loaded with feature files, rules, and specs.
- Enables demonstrating specification editing workflow.
- Re-sets state on a browser reload.

Notes and Possibilities:

- Maybe: links to a made-up issue tracker from specs?
- Launch Coding Session is a partial no-op.
  - It may show the name and config captured for the session.
  - It may allow capturing a prompt to the clipboard (same as regular mode)
  - It may describe what would happen next (launch an agent w/prompt).
  - It may create pretend session output and results.
- May allow scripted replay of a coding session, whether timed or step-by-step, like a slideshow. Automerge might support this with little coding logic on our part.

## Scripting, Session Capture and Script Replay

- Session Replay: supports demo or tutorial mode
- Session capture, undo/redo, replay, scripting: do we have a user case for this?
  - company makes its own tutorials
  - scripting of plugin install, or validating the application state (Nix inspiration: consistency check?)

### Edit and Event Replay for Demo

Adding event capture and replay enables demonstration of the SpecDriven app,
whether interactive (following the steps) or automatic (like a timed slideshow).

Automerge might already have affordances for playing events back, given that
it's already designed around reconciling updates to a set of files.

Caution: Supporting UI navigation and dialogue replay may require creating a
user and system event model and an application state model. Since the
undo/replay log is application state, we need to decide how and when to manage
it, and when to discard or clear it. Maybe it's only active in demo mode, to
avoid interaction problems. In order to support a demonstration, we do need to
be able to capture a set of events and an initial state, at least.
