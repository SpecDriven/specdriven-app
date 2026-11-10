# Changelog

What changed in each release of SpecDriven, newest first. `bun run bump` writes
each version's section from the pull requests merged since the version before
it ([docs/releasing.md](docs/releasing.md)).

## v0.1.255 — 2026-11-10

- User info: view ~/.specdriven/settings.json in readable form, with Copy contents ([#424](https://github.com/SpecDriven/specdriven-app/pull/424))
- Project settings: edit a member's name and email ([#423](https://github.com/SpecDriven/specdriven-app/pull/423))

## v0.1.254 — 2026-11-10

- Feature name: Edit display name in the sidebar menu; header edit survives sync ([#422](https://github.com/SpecDriven/specdriven-app/pull/422))
- Run the single-user app in Podman with no host folder mounted ([#421](https://github.com/SpecDriven/specdriven-app/pull/421))

## v0.1.253 — 2026-11-09

- Settings: pick the Git access — GitHub CLI (recommended), personal access token or GitHub account ([#420](https://github.com/SpecDriven/specdriven-app/pull/420))
- Import from OpenSpec: a code repo's openspec/specs become features ([#419](https://github.com/SpecDriven/specdriven-app/pull/419))
- Settings: the personal access token is always offered, in its own section ([#418](https://github.com/SpecDriven/specdriven-app/pull/418))

## v0.1.252 — 2026-11-09

- Settings: hide the GitHub account behind an off-by-default switch ([#417](https://github.com/SpecDriven/specdriven-app/pull/417))
- Settings: remove the Code repo submodule row, its route and server module ([#416](https://github.com/SpecDriven/specdriven-app/pull/416))

## v0.1.251 — 2026-11-09

- Sync: a push that fails is shown, and the commits it left behind go up on the next sync ([#415](https://github.com/SpecDriven/specdriven-app/pull/415))
- Plugins: pull the default marketplace on start and offer the plugins with an update in a dialog ([#414](https://github.com/SpecDriven/specdriven-app/pull/414))
- settings.json: one recentFolders list, and a settingsVersion with upgrade steps ([#413](https://github.com/SpecDriven/specdriven-app/pull/413))

## v0.1.250 — 2026-11-09

- Agent pane: a folder switch tries the agent's API again, and the pane warns when it does not answer ([#412](https://github.com/SpecDriven/specdriven-app/pull/412))
- Agent pane header: show API or ACNT with no session open too ([#411](https://github.com/SpecDriven/specdriven-app/pull/411))

## v0.1.249 — 2026-11-09

- One folder list: spec folders and code repositories together, each marked by kind ([#410](https://github.com/SpecDriven/specdriven-app/pull/410))
- Agent pane header: the account chip always reads API or ACNT ([#409](https://github.com/SpecDriven/specdriven-app/pull/409))
- Remove the Change data directory button; Manage folders is the one way to change folders ([#408](https://github.com/SpecDriven/specdriven-app/pull/408))

## v0.1.248 — 2026-11-08

- Settings: the desktop app and the app's own checkout use ~/.specdriven/settings.json only ([#407](https://github.com/SpecDriven/specdriven-app/pull/407))

## v0.1.247 — 2026-11-08

- Open a code repository directly, with a file tree, a plain editor and Open in IntelliJ ([#405](https://github.com/SpecDriven/specdriven-app/pull/405))

## v0.1.246 — 2026-11-08

- Coding agent pane: session tabs on the header line, not a row of their own ([#404](https://github.com/SpecDriven/specdriven-app/pull/404))
- Coding agent pane: a tab per session, at most five open ([#403](https://github.com/SpecDriven/specdriven-app/pull/403))
- Clicking the version opens Check for Updates; drop it from the user menu ([#402](https://github.com/SpecDriven/specdriven-app/pull/402))

## v0.1.245 — 2026-11-07

- Marketplace Refresh clones a copy afresh when it cannot pull; drop Re-clone ([#401](https://github.com/SpecDriven/specdriven-app/pull/401))

## v0.1.244 — 2026-11-07

- Name JS tests whose title is wrapped under the call, or declared through an alias ([#400](https://github.com/SpecDriven/specdriven-app/pull/400))
- Turn Jira and Confluence on and off in Settings ([#396](https://github.com/SpecDriven/specdriven-app/pull/396))
- Show a session's folder, branch and context window in the agent pane's header ([#398](https://github.com/SpecDriven/specdriven-app/pull/398))
- Count the project's scenarios by status in the Specs section head ([#399](https://github.com/SpecDriven/specdriven-app/pull/399))

## v0.1.243 — 2026-11-07

- adding docs
- Open a worktree session in a Ghostty shell from the agent pane ([#397](https://github.com/SpecDriven/specdriven-app/pull/397))

## v0.1.242 — 2026-11-06

- Check a coding session's source is up to date before it starts ([#395](https://github.com/SpecDriven/specdriven-app/pull/395))
- Show a worktree session's full branch name when the agent pane is wide ([#394](https://github.com/SpecDriven/specdriven-app/pull/394))

## v0.1.241 — 2026-11-06

- Run a coding agent session in a git worktree of its own ([#393](https://github.com/SpecDriven/specdriven-app/pull/393))

## v0.1.240 — 2026-11-06

- Upload pasted images to GitHub when creating or editing an issue ([#392](https://github.com/SpecDriven/specdriven-app/pull/392))

## v0.1.239 — 2026-11-06

- The coding agent pane's model menu lists the models the sign-in offers now ([#390](https://github.com/SpecDriven/specdriven-app/pull/390))

## v0.1.238 — 2026-11-06

- Keep a new GitHub issue as a draft until it is created ([#391](https://github.com/SpecDriven/specdriven-app/pull/391))

## v0.1.237 — 2026-11-06

- Hand every agent session a Confluence MCP server so agents can read the wiki ([#387](https://github.com/SpecDriven/specdriven-app/pull/387))

## v0.1.236 — 2026-11-06

- Pick several scenarios in the sidebar tree and delete them in one go ([#386](https://github.com/SpecDriven/specdriven-app/pull/386))

## v0.1.235 — 2026-11-05

- Model menus show each model's display name, in the agent pane and Import from Jira/Wiki alike ([#385](https://github.com/SpecDriven/specdriven-app/pull/385))

## v0.1.234 — 2026-11-05

- Each agent's model list lives in its own Settings section; drop the AI agents section and Settings → Jira's Import model ([#384](https://github.com/SpecDriven/specdriven-app/pull/384))

## v0.1.233 — 2026-11-05

- Agent model lists: one file per agent, checked against the models the agent's API reports ([#383](https://github.com/SpecDriven/specdriven-app/pull/383))
- Import dialog and Settings → Jira offer the models the agent lists, narrowed by Settings → AI agents ([#382](https://github.com/SpecDriven/specdriven-app/pull/382))

## v0.1.232 — 2026-11-05

- Sidebar consistency, phase 3: one row for every plugin list, progress rings, a tab bar that never wraps ([#381](https://github.com/SpecDriven/specdriven-app/pull/381))
- Sidebar consistency, phase 2: one section head for every tab, tree keyboard model and reveal in plugin lists ([#380](https://github.com/SpecDriven/specdriven-app/pull/380))

## v0.1.231 — 2026-11-05

- Sidebar consistency, phase 1: one ⋯ menu order, Copy link on tree rows, chord fixes, rail parity, grouped user menu ([#379](https://github.com/SpecDriven/specdriven-app/pull/379))

## v0.1.230 — 2026-11-04

- Paste an image into the coding agent pane's message ([#378](https://github.com/SpecDriven/specdriven-app/pull/378))
- A turn that failed to sign in offers Open Settings even when the reply already said why ([#377](https://github.com/SpecDriven/specdriven-app/pull/377))
- Project settings: code repo rows stack path, folder and symlink lines so long paths no longer crowd the controls ([#376](https://github.com/SpecDriven/specdriven-app/pull/376))

## v0.1.229 — 2026-11-04

- A code repo that is not on this computer is offered for cloning when its data folder opens ([#375](https://github.com/SpecDriven/specdriven-app/pull/375))

## v0.1.228 — 2026-11-04

- Project settings are created for every data folder, name several code repos with their specs symlinks, and have a page in the user menu ([#374](https://github.com/SpecDriven/specdriven-app/pull/374))

## v0.1.227 — 2026-11-04

- The editor shows colored and highlighted text as it reads, and undoes with ⌘Z ([#373](https://github.com/SpecDriven/specdriven-app/pull/373))

## v0.1.226 — 2026-11-04

- The Updates page on macOS says Admin privileges may be needed to update ([#372](https://github.com/SpecDriven/specdriven-app/pull/372))
- Restarting into a new version no longer fails with ENOTEMPTY on the previous bundle ([#371](https://github.com/SpecDriven/specdriven-app/pull/371))

## v0.1.225 — 2026-11-04

- Publishing qTest test cases again deletes the test cases of scenarios no longer in the feature ([#370](https://github.com/SpecDriven/specdriven-app/pull/370))
- Saving an image markup no longer fails on a flat line or a lone pen dot ([#368](https://github.com/SpecDriven/specdriven-app/pull/368))
- The editor's toolbar has a Font color menu next to Bold ([#369](https://github.com/SpecDriven/specdriven-app/pull/369))

## v0.1.224 — 2026-11-04

- The coding agent pane's composer bar stays on one row, and the pane is at least 420px wide ([#367](https://github.com/SpecDriven/specdriven-app/pull/367))

## v0.1.223 — 2026-11-04

- The coding agent pane picks folder, model, effort and mode in a bar under the message box ([#366](https://github.com/SpecDriven/specdriven-app/pull/366))

## v0.1.222 — 2026-11-03

- A scenario added with + is saved the moment it opens, empty body and all ([#365](https://github.com/SpecDriven/specdriven-app/pull/365))

## v0.1.221 — 2026-11-02

- The desktop app checks for updates once a day and marks the version chip ([#364](https://github.com/SpecDriven/specdriven-app/pull/364))
- Check for Updates…: the desktop app updates itself ([#363](https://github.com/SpecDriven/specdriven-app/pull/363))
- Include CHANGELOG.md in the Docker images ([#362](https://github.com/SpecDriven/specdriven-app/pull/362))
- Release notes in CHANGELOG.md, on the GitHub release and in the app ([#361](https://github.com/SpecDriven/specdriven-app/pull/361))
- Test every step of "A blocked app does not push" ([#360](https://github.com/SpecDriven/specdriven-app/pull/360))

## v0.1.220 — 2026-11-02

- Publish a feature to the Wiki and qTest from one dialog ([#359](https://github.com/SpecDriven/specdriven-app/pull/359))
- Re-clone a marketplace whose copy can no longer be refreshed ([#358](https://github.com/SpecDriven/specdriven-app/pull/358))

## v0.1.219 — 2026-11-02

- Copy link on the public specs site for features and scenarios ([#357](https://github.com/SpecDriven/specdriven-app/pull/357))
- The sidebar tree follows the open feature ([#356](https://github.com/SpecDriven/specdriven-app/pull/356))

## v0.1.218 — 2026-11-02

- Model dropdowns list only the agent's models, the first chosen ([#355](https://github.com/SpecDriven/specdriven-app/pull/355))

## v0.1.217 — 2026-11-02

- Agent model lists in the data repo, chosen from dropdowns ([#354](https://github.com/SpecDriven/specdriven-app/pull/354))

## v0.1.216 — 2026-11-02

- Remove the spec proposals service ([#353](https://github.com/SpecDriven/specdriven-app/pull/353))

## v0.1.215 — 2026-11-01

- Spec folders: one entry per repository, url or folder ([#351](https://github.com/SpecDriven/specdriven-app/pull/351))

## v0.1.214 — 2026-11-01

- Plugins: refresh the marketplaces on start when external plugins are installed ([#350](https://github.com/SpecDriven/specdriven-app/pull/350))
- Agent pane: follow an agent's new sign-in without a restart ([#349](https://github.com/SpecDriven/specdriven-app/pull/349))

## v0.1.213 — 2026-11-01

- Agent pane: open an agent's own Settings section to set it up or sign in ([#348](https://github.com/SpecDriven/specdriven-app/pull/348))

## v0.1.212 — 2026-11-01

- Release: build Windows installers on request, not on every release ([#347](https://github.com/SpecDriven/specdriven-app/pull/347))

## v0.1.211 — 2026-11-01

- Marketplace: reinstall a plugin whose id is installed already ([#346](https://github.com/SpecDriven/specdriven-app/pull/346))
- Release: attach x64 and arm64 Windows installers to every release ([#345](https://github.com/SpecDriven/specdriven-app/pull/345))

## v0.1.210 — 2026-11-01

- Agent pane button: show an agent plugin that arrives while the window is open ([#344](https://github.com/SpecDriven/specdriven-app/pull/344))
- User corner: show the app version beside the user name on every copy ([#343](https://github.com/SpecDriven/specdriven-app/pull/343))

## v0.1.209 — 2026-11-01

- Archive roadmap pages into their Automerge documents ([#341](https://github.com/SpecDriven/specdriven-app/pull/341))
- User info: read the commit identity in the data repo, not the app's folder ([#340](https://github.com/SpecDriven/specdriven-app/pull/340))
- Clone on the built-in engine from the target's parent so Windows paths work ([#339](https://github.com/SpecDriven/specdriven-app/pull/339))
- Releases: sign SHASUMS256.txt, attest build provenance, installers verify the signature ([#338](https://github.com/SpecDriven/specdriven-app/pull/338))
- Docs: module map diagram with architecture findings ([#322](https://github.com/SpecDriven/specdriven-app/pull/322))
- Add a module diagram of the app with its import edges and smells ([#321](https://github.com/SpecDriven/specdriven-app/pull/321))
- Supply-chain hardening for the public repository ([#330](https://github.com/SpecDriven/specdriven-app/pull/330))
- Point README demo link at demo.specdriven.app ([#329](https://github.com/SpecDriven/specdriven-app/pull/329))
- Releases: publish on SpecDriven/specdriven-app instead of specdriven-app-release ([#328](https://github.com/SpecDriven/specdriven-app/pull/328))
- Public read-only specs site (SPECDRIVEN_READONLY=1) ([#327](https://github.com/SpecDriven/specdriven-app/pull/327))
- Editors: spell check in every prose field, with a Settings switch ([#326](https://github.com/SpecDriven/specdriven-app/pull/326))
- README: concise landing page for open-sourcing; move the detail into docs/ ([#325](https://github.com/SpecDriven/specdriven-app/pull/325))
- License: switch from AGPL-3.0-only to Apache-2.0 ([#323](https://github.com/SpecDriven/specdriven-app/pull/323))

## v0.1.200 — 2026-10-31

- Tasks: projects group tasks and can be assigned to a member ([#320](https://github.com/SpecDriven/specdriven-app/pull/320))
- CI: ignore minimatch GHSA-g3hv-75wg-m249 in the audit step ([#319](https://github.com/SpecDriven/specdriven-app/pull/319))

## v0.1.199 — 2026-10-31

- Installer: keep the version an update replaces, clear out older ones ([#318](https://github.com/SpecDriven/specdriven-app/pull/318))

## v0.1.198 — 2026-10-30

- Several Jira tickets on a feature, each test case linked to every ticket's qTest requirement ([#317](https://github.com/SpecDriven/specdriven-app/pull/317))

## v0.1.197 — 2026-10-30

- qTest: link each test case to the Jira issue's requirement, and offer a feature its own parent module ([#316](https://github.com/SpecDriven/specdriven-app/pull/316))

## v0.1.196 — 2026-10-29

- Import from Jira/Wiki: a feature proposed from Jira issues and Confluence pages, with the model chosen before Analyze ([#315](https://github.com/SpecDriven/specdriven-app/pull/315))
- Refresh the open Roadmap page and plugin tabs on Sync ([#314](https://github.com/SpecDriven/specdriven-app/pull/314))
- Accept a qTest token pasted as "Bearer <token>" and keep only the token ([#313](https://github.com/SpecDriven/specdriven-app/pull/313))

## v0.1.195 — 2026-10-29

- qTest: link test cases to their scenario on the Confluence page; keep fields on re-publish ([#312](https://github.com/SpecDriven/specdriven-app/pull/312))

## v0.1.194 — 2026-10-29

- qTest: accept real module urls, Bearer token wording, and tokens without field-settings access ([#311](https://github.com/SpecDriven/specdriven-app/pull/311))
- Keep plugin documents out of Data's Event models; separate thousands in its counts; close test gaps ([#310](https://github.com/SpecDriven/specdriven-app/pull/310))
- Find, browse and delete stored images no feature references ([#309](https://github.com/SpecDriven/specdriven-app/pull/309))
- Rename a scenario's Duplicate to Clone ([#308](https://github.com/SpecDriven/specdriven-app/pull/308))

## v0.1.193 — 2026-10-28

- Browse the Automerge store as tables, documents and history on a read-only Data page ([#307](https://github.com/SpecDriven/specdriven-app/pull/307))

## v0.1.192 — 2026-10-28

- Drag scenario cards and outline rows onto another feature to move them ([#306](https://github.com/SpecDriven/specdriven-app/pull/306))

## v0.1.191 — 2026-10-28

- Move a published scenario back to proposed while Settings allows deleting published specs ([#305](https://github.com/SpecDriven/specdriven-app/pull/305))

## v0.1.190 — 2026-10-28

- Replace the big action buttons with icons, chip menus and a next-scenario action in the editor ([#304](https://github.com/SpecDriven/specdriven-app/pull/304))

## v0.1.189 — 2026-10-27

- Mark up an image in a spec with boxes and arrows, through Excalidraw ([#303](https://github.com/SpecDriven/specdriven-app/pull/303))

## v0.1.188 — 2026-10-26

- Move a folder to the top level or into another folder ([#302](https://github.com/SpecDriven/specdriven-app/pull/302))
- Line up the agent picker's radios with their labels ([#301](https://github.com/SpecDriven/specdriven-app/pull/301))

## v0.1.187 — 2026-10-26

- Drop the one-release shims left from the agent plugin move ([#300](https://github.com/SpecDriven/specdriven-app/pull/300))

## v0.1.186 — 2026-10-26

- Drop the built-in agent plugins: the agents come from the marketplace ([#299](https://github.com/SpecDriven/specdriven-app/pull/299))
- Let an installed agent plugin build against the host SDK and switch itself on ([#298](https://github.com/SpecDriven/specdriven-app/pull/298))
- Make the three coding agents built-in plugins with their own settings and secrets ([#297](https://github.com/SpecDriven/specdriven-app/pull/297))

## v0.1.185 — 2026-10-26

- Publish a folder's features to Confluence ([#296](https://github.com/SpecDriven/specdriven-app/pull/296))
- Put the coding agent pane behind one agent interface ([#295](https://github.com/SpecDriven/specdriven-app/pull/295))

## v0.1.184 — 2026-10-26

- Give a new folder its name in initial case as its display name ([#294](https://github.com/SpecDriven/specdriven-app/pull/294))

## v0.1.183 — 2026-10-26

- Make the desktop bundle self-contained: ship Automerge's wasm and cbor-extract beside it ([#293](https://github.com/SpecDriven/specdriven-app/pull/293))

## v0.1.182 — 2026-10-26

- Move the desktop app to Electron 44.9.3 ([#292](https://github.com/SpecDriven/specdriven-app/pull/292))
- Duplicate a scenario from its menus ([#291](https://github.com/SpecDriven/specdriven-app/pull/291))
- Reorder features within a folder, as folders are ([#290](https://github.com/SpecDriven/specdriven-app/pull/290))
- Log qTest traffic and show error details on click ([#289](https://github.com/SpecDriven/specdriven-app/pull/289))

## v0.1.181 — 2026-10-25

- Reorder roadmap pages, as tasks are ([#287](https://github.com/SpecDriven/specdriven-app/pull/287))
- Reorder tasks by dragging, and give task folders a menu ([#286](https://github.com/SpecDriven/specdriven-app/pull/286))
- Reorder spec folders from the sidebar ([#285](https://github.com/SpecDriven/specdriven-app/pull/285))
- Copy the app icon into the hosted image ([#284](https://github.com/SpecDriven/specdriven-app/pull/284))

## v0.1.180 — 2026-10-24

- Render deep-link entry into the packaged desktop app ([#283](https://github.com/SpecDriven/specdriven-app/pull/283))

## v0.1.179 — 2026-10-24

- Ship only the bundles in the desktop package ([#282](https://github.com/SpecDriven/specdriven-app/pull/282))

## v0.1.178 — 2026-10-24

- Fail the workflow on TypeScript errors ([#281](https://github.com/SpecDriven/specdriven-app/pull/281))
- Design and install the application icon ([#280](https://github.com/SpecDriven/specdriven-app/pull/280))
- Fix draft scenarios opening on "This view hit an error" ([#279](https://github.com/SpecDriven/specdriven-app/pull/279))

## v0.1.177 — 2026-10-23

- Clear the dependency audit (electron, happy-dom, body-parser, fast-uri, undici) ([#278](https://github.com/SpecDriven/specdriven-app/pull/278))
- Edit a folder's display name from its menu ([#277](https://github.com/SpecDriven/specdriven-app/pull/277))
- Switch "Import features from Aha!" on in Settings ([#276](https://github.com/SpecDriven/specdriven-app/pull/276))

## v0.1.176 — 2026-10-23

- Edit markdown tables in a dialog from the editor toolbar ([#275](https://github.com/SpecDriven/specdriven-app/pull/275))
- Show a scenario's automated tests right under its body ([#274](https://github.com/SpecDriven/specdriven-app/pull/274))

## v0.1.175 — 2026-10-23

- Remember each feature's Confluence parent page in its document ([#273](https://github.com/SpecDriven/specdriven-app/pull/273))
- Keep a dialog open when a text selection drag ends outside it ([#272](https://github.com/SpecDriven/specdriven-app/pull/272))
- Show and log the details of a failed Confluence call ([#271](https://github.com/SpecDriven/specdriven-app/pull/271))

## v0.1.174 — 2026-10-22

- Open the scenario editor on the rendered Preview tab ([#270](https://github.com/SpecDriven/specdriven-app/pull/270))

## v0.1.173 — 2026-10-22

- Reorder scenarios by dragging them in the sidebar outline ([#269](https://github.com/SpecDriven/specdriven-app/pull/269))
- Import a feature from Aha!: routes, key store and markdown mapping ([#265](https://github.com/SpecDriven/specdriven-app/pull/265))
- Override dompurify and ip-address to patched releases for bun audit ([#268](https://github.com/SpecDriven/specdriven-app/pull/268))

## v0.1.172 — 2026-10-22

- Don't overwrite edits made directly in Confluence without asking ([#267](https://github.com/SpecDriven/specdriven-app/pull/267))
- Create qTest test cases from a feature's scenarios ([#264](https://github.com/SpecDriven/specdriven-app/pull/264))

## v0.1.171 — 2026-10-21

- Copy link button in the scenario editor's top bar ([#263](https://github.com/SpecDriven/specdriven-app/pull/263))

## v0.1.170 — 2026-10-21

- Attach an image edited in place to Confluence under the name its bytes earn ([#262](https://github.com/SpecDriven/specdriven-app/pull/262))

## v0.1.169 — 2026-10-21

- Install an AGENTS.md spec-writing guide into data folders that have none ([#261](https://github.com/SpecDriven/specdriven-app/pull/261))

## v0.1.168 — 2026-10-21

- Publish a feature's stored images to Confluence as page attachments ([#260](https://github.com/SpecDriven/specdriven-app/pull/260))

## v0.1.167 — 2026-10-21

- Colour the Confluence polarity sections instead of badging each scenario ([#259](https://github.com/SpecDriven/specdriven-app/pull/259))

## v0.1.166 — 2026-10-21

- Mark scenarios positive or negative, and group a Confluence page by it ([#258](https://github.com/SpecDriven/specdriven-app/pull/258))

## v0.1.165 — 2026-10-20

- Keep scenario text the parser used to drop: a Tests heading over notes, and a body's first-line indentation ([#257](https://github.com/SpecDriven/specdriven-app/pull/257))
- Number scenarios on the Confluence page, each an anchor to link to ([#256](https://github.com/SpecDriven/specdriven-app/pull/256))

## v0.1.164 — 2026-10-20

- Number scenarios by position and let the user move them up and down ([#255](https://github.com/SpecDriven/specdriven-app/pull/255))
- Remove the Lean verification experiment ([#254](https://github.com/SpecDriven/specdriven-app/pull/254))

## v0.1.163 — 2026-10-20

- Lift @modelcontextprotocol/sdk to 1.32.1 so the audit job passes again ([#251](https://github.com/SpecDriven/specdriven-app/pull/251))
- Auto-save commits say what changed ([#253](https://github.com/SpecDriven/specdriven-app/pull/253))

## v0.1.162 — 2026-10-20

- Refuse feature writes that end inside an open code fence ([#252](https://github.com/SpecDriven/specdriven-app/pull/252))

## v0.1.161 — 2026-10-20

- Scenario editor: the name field sizes to its text instead of cutting off at 22rem ([#250](https://github.com/SpecDriven/specdriven-app/pull/250))

## v0.1.160 — 2026-10-20

- Folder descriptions: a description.txt in a specs folder labels it in the sidebar ([#249](https://github.com/SpecDriven/specdriven-app/pull/249))

## v0.1.159 — 2026-10-19

- Regenerate bun.lock for the new lint devDependencies; drop the stray package-lock.json ([#248](https://github.com/SpecDriven/specdriven-app/pull/248))

## v0.1.158 — 2026-10-19

- Settings → Claude: choose the claude.ai login or an API proxy for every Claude the app starts (specs/agents/claude.feature.md) ([#247](https://github.com/SpecDriven/specdriven-app/pull/247))
- Fix this app: a coding agent fixes the installed source, and the app rebuilds and restarts into the fix (specs/app/self-healing.feature.md) ([#246](https://github.com/SpecDriven/specdriven-app/pull/246))

## v0.1.157 — 2026-10-19

- Folder menu in the Specs sidebar: rename, delete, create inside, move (specs/ui/folders.feature.md) ([#245](https://github.com/SpecDriven/specdriven-app/pull/245))

## v0.1.156 — 2026-10-19

- Maintenance release.

## v0.1.155 — 2026-10-19

- Move the window from the top of either pane (specs/app/desktop-app.feature.md) ([#244](https://github.com/SpecDriven/specdriven-app/pull/244))

## v0.1.154 — 2026-10-19

- Leave scenario status and version off Confluence pages (specs/external-links/confluence-wiki.feature.md) ([#243](https://github.com/SpecDriven/specdriven-app/pull/243))

## v0.1.153 — 2026-10-16

- Publish a feature to a Confluence wiki page (specs/external-links/confluence-wiki.feature.md) ([#242](https://github.com/SpecDriven/specdriven-app/pull/242))

## v0.1.152 — 2026-10-15

- Stop an older app from writing to data saved by a newer one ([#241](https://github.com/SpecDriven/specdriven-app/pull/241))

## v0.1.151 — 2026-10-15

- Hosted start screen: link the account page, the admin page and Sign out before a repo opens ([#240](https://github.com/SpecDriven/specdriven-app/pull/240))

## v0.1.150 — 2026-10-14

- Issues: send GitHub API requests to the repo's host, tokens to their own host only ([#239](https://github.com/SpecDriven/specdriven-app/pull/239))

## v0.1.149 — 2026-10-14

- Desktop app: sign in with a GitHub token and sign out from the user menu ([#238](https://github.com/SpecDriven/specdriven-app/pull/238))

## v0.1.148 — 2026-10-14

- Rename the new-account role test so specs can link it (no colon in the title) ([#237](https://github.com/SpecDriven/specdriven-app/pull/237))

## v0.1.147 — 2026-10-14

- Settings: give Aha! and Figma their own sections ([#236](https://github.com/SpecDriven/specdriven-app/pull/236))

## v0.1.146 — 2026-10-14

- Link a qTest test case to a feature and each scenario, switched on in Settings (specs/external-links/qtest-test-cases.feature.md) ([#235](https://github.com/SpecDriven/specdriven-app/pull/235))

## v0.1.145 — 2026-10-13

- Custom attributes on features and scenarios, defined in custom-attributes.txt (specs/app/custom-attributes.feature.md) ([#234](https://github.com/SpecDriven/specdriven-app/pull/234))

## v0.1.144 — 2026-10-13

- Maintenance release.

## v0.1.143 — 2026-10-13

- Clone from GitHub with a personal access token, GitHub Enterprise, --profile; show clone dirs in Spec folders ([#233](https://github.com/SpecDriven/specdriven-app/pull/233))
- Scenario editor: previous / next scenario buttons and keys ([#232](https://github.com/SpecDriven/specdriven-app/pull/232))

## v0.1.142 — 2026-10-13

- Feature flags on features and scenarios, behind a Settings switch (specs/app/feature-flags.feature.md) ([#231](https://github.com/SpecDriven/specdriven-app/pull/231))
- Hosted: remember each user's recent data repos in the datastore ([#230](https://github.com/SpecDriven/specdriven-app/pull/230))

## v0.1.141 — 2026-10-12

- Go back to a specs symlink into ../specs-specdriven; drop the specs-specdriven submodule

## v0.1.140 — 2026-10-12

- Link features and scenarios to Aha! and Figma, each behind a Settings switch (specs/external-links/aha-and-figma-links.feature.md) ([#229](https://github.com/SpecDriven/specdriven-app/pull/229))

## v0.1.139 — 2026-10-12

- Hosted gateway: redirect page loads on another host name to PUBLIC_URL ([#228](https://github.com/SpecDriven/specdriven-app/pull/228))
- Docs: custom domains on Cloudflare for the Railway services (docs/deployment-railway.md) ([#227](https://github.com/SpecDriven/specdriven-app/pull/227))

## v0.1.138 — 2026-10-12

- Hosted app: admin and user roles; admins keep the allowed emails (docs/deployment-railway.md) ([#226](https://github.com/SpecDriven/specdriven-app/pull/226))

## v0.1.137 — 2026-10-11

- User guide: show one folder of the specs from a code repo submodule ([#225](https://github.com/SpecDriven/specdriven-app/pull/225))
- Add the spec repo to a code repo as a git submodule; make specs-specdriven a submodule (specs/app/code-repo-submodule.feature.md) ([#224](https://github.com/SpecDriven/specdriven-app/pull/224))
- Keep hosted accounts in the datastore repo across redeploys (specs/app/hosted-app.feature.md) ([#223](https://github.com/SpecDriven/specdriven-app/pull/223))
- Run the install.ps1 tests only when the installer changes (specs/app/installation.feature.md) ([#222](https://github.com/SpecDriven/specdriven-app/pull/222))

## v0.1.136 — 2026-10-11

- Let the scenario body be dragged taller; the pane scrolls (specs/editor/spec-editor.feature.md) ([#221](https://github.com/SpecDriven/specdriven-app/pull/221))

## v0.1.135 — 2026-10-10

- Maintenance release.

## v0.1.134 — 2026-10-10

- Install on Windows from PowerShell (specs/app/installation.feature.md) ([#220](https://github.com/SpecDriven/specdriven-app/pull/220))
- Move the feature's Copy link into its ⋯ menu (specs/ui/navigation.feature.md) ([#219](https://github.com/SpecDriven/specdriven-app/pull/219))
- Test the close-prs workflow (specs/app/open-source-license.feature.md) ([#218](https://github.com/SpecDriven/specdriven-app/pull/218))

## v0.1.133 — 2026-10-10

- Store files with each scenario (specs/editor/store-associated-files.feature.md) ([#216](https://github.com/SpecDriven/specdriven-app/pull/216))
- Add a checker and Claude Code hooks that keep spec test links naming their tests (specs/external-links/test-traceability.feature.md) ([#217](https://github.com/SpecDriven/specdriven-app/pull/217))
- Repoint code comments at spec files that exist ([#215](https://github.com/SpecDriven/specdriven-app/pull/215))
- Point the gateway's app-shell comment at the navigation spec that exists (specs/ui/navigation.feature.md) ([#214](https://github.com/SpecDriven/specdriven-app/pull/214))
- Drop the colons from three demo test titles so spec test links can name them (specs/app/public-demo.feature.md) ([#213](https://github.com/SpecDriven/specdriven-app/pull/213))
- Drop the colon from a gateway test title so its spec test link can name it (specs/app/hosted-app.feature.md) ([#212](https://github.com/SpecDriven/specdriven-app/pull/212))

## v0.1.132 — 2026-10-10

- Keep the Notebook for older settings files with no plugin list (specs/app/plugins.feature.md) ([#211](https://github.com/SpecDriven/specdriven-app/pull/211))
- Rename six test titles so spec test links can name them, and use the repo's current name (specs/external-links/test-traceability.feature.md) ([#210](https://github.com/SpecDriven/specdriven-app/pull/210))

## v0.1.131 — 2026-10-09

- Add the spec proposals service (specs/app/spec-proposals.feature.md) ([#209](https://github.com/SpecDriven/specdriven-app/pull/209))
- Relicense under AGPL-3.0-only and stop accepting pull requests (specs/app/open-source-license.feature.md) ([#208](https://github.com/SpecDriven/specdriven-app/pull/208))

## v0.1.130 — 2026-10-09

- Drop the colons from two authorship test titles so spec test links can name them (specs/app/specs-authorship.feature.md) ([#207](https://github.com/SpecDriven/specdriven-app/pull/207))
- Record who created and last updated features and scenarios (specs/app/specs-authorship.feature.md) ([#206](https://github.com/SpecDriven/specdriven-app/pull/206))

## v0.1.129 — 2026-10-09

- Run the public demo when DEMO_MODE is set on the hosted image ([#205](https://github.com/SpecDriven/specdriven-app/pull/205))

## v0.1.128 — 2026-10-09

- Skip hosted-mode variable checks in DEMO_MODE ([#204](https://github.com/SpecDriven/specdriven-app/pull/204))

## v0.1.127 — 2026-10-09

- Keep the plugin list per data folder ([#203](https://github.com/SpecDriven/specdriven-app/pull/203))
- Add hosted multi-user deployment for Railway ([#202](https://github.com/SpecDriven/specdriven-app/pull/202))

## v0.1.126 — 2026-10-07

- Netsync stop waits for an absorb in flight and absorbs nothing after ([#201](https://github.com/SpecDriven/specdriven-app/pull/201))
- Fail a Claude turn fast when the API proxy does not answer ([#200](https://github.com/SpecDriven/specdriven-app/pull/200))

## v0.1.125 — 2026-10-07

- Fix the lean tests' type errors ([#199](https://github.com/SpecDriven/specdriven-app/pull/199))
- Break the pages -> git -> demo -> plugin host import cycle ([#198](https://github.com/SpecDriven/specdriven-app/pull/198))
- Faster, deterministic tests via cached fakes and test doubles ([#197](https://github.com/SpecDriven/specdriven-app/pull/197))

## v0.1.124 — 2026-10-07

- Deterministic netsync remote-absorb test via a fake sync server ([#196](https://github.com/SpecDriven/specdriven-app/pull/196))
- Remove flaky netsync remote-absorb test ([#195](https://github.com/SpecDriven/specdriven-app/pull/195))

## v0.1.123 — 2026-10-07

- Agent pane shows how a Claude session is signed in and billed ([#194](https://github.com/SpecDriven/specdriven-app/pull/194))

## v0.1.122 — 2026-10-07

- Override @modelcontextprotocol/sdk to 1.31.0 for GHSA-6qxp-vccf-f47h ([#193](https://github.com/SpecDriven/specdriven-app/pull/193))

## v0.1.121 — 2026-10-07

- Save the data folder without a trailing slash ([#192](https://github.com/SpecDriven/specdriven-app/pull/192))

## v0.1.120 — 2026-10-07

- Agent folder menu no longer lists a folder twice when typed with a trailing slash ([#191](https://github.com/SpecDriven/specdriven-app/pull/191))

## v0.1.119 — 2026-10-07

- Agent pane — Auto mode by default, described mode menu, switchable folder ([#190](https://github.com/SpecDriven/specdriven-app/pull/190))

## v0.1.118 — 2026-10-07

- Maintenance release.

## v0.1.117 — 2026-10-05

- The browser start no longer sits on the loading skeleton when the server can't be reached ([#187](https://github.com/SpecDriven/specdriven-app/pull/187))

## v0.1.116 — 2026-10-05

- A README autosave no longer overwrites concurrent disk edits ([#186](https://github.com/SpecDriven/specdriven-app/pull/186))
- Dialog Publish waits for an in-flight autosave before placing ([#185](https://github.com/SpecDriven/specdriven-app/pull/185))

## v0.1.115 — 2026-10-05

- Increase and decrease font size in every markdown editor ([#184](https://github.com/SpecDriven/specdriven-app/pull/184))

## v0.1.114 — 2026-10-05

- Make web links clickable in every markdown editor ([#183](https://github.com/SpecDriven/specdriven-app/pull/183))

## v0.1.113 — 2026-10-05

- Moving, renaming or deleting a feature no longer recreates its old file from a stale editor save ([#182](https://github.com/SpecDriven/specdriven-app/pull/182))
- Absorb a hand edit that rode along with Automerge operations (H1) ([#172](https://github.com/SpecDriven/specdriven-app/pull/172))

## v0.1.112 — 2026-10-05

- Move a scenario to another feature from its sidebar menu ([#181](https://github.com/SpecDriven/specdriven-app/pull/181))
- Clear the dependency audit (proxy-addr, source-map-js, sprintf-js, katex) ([#180](https://github.com/SpecDriven/specdriven-app/pull/180))
- Cover the desktop app's link routing and Linux packaging ([#179](https://github.com/SpecDriven/specdriven-app/pull/179))

## v0.1.111 — 2026-10-05

- Clean up whitespace in everything the user types ([#178](https://github.com/SpecDriven/specdriven-app/pull/178))

## v0.1.110 — 2026-10-05

- Ask before creating a spec folder that does not exist ([#177](https://github.com/SpecDriven/specdriven-app/pull/177))

## v0.1.109 — 2026-10-05

- A deleted scenario no longer reappears in the tree after opening another feature ([#176](https://github.com/SpecDriven/specdriven-app/pull/176))

## v0.1.108 — 2026-10-05

- Delete a scenario from its sidebar tree row ([#175](https://github.com/SpecDriven/specdriven-app/pull/175))

## v0.1.107 — 2026-10-05

- Renaming a scenario no longer adds it again on every autosave tick (#173) ([#174](https://github.com/SpecDriven/specdriven-app/pull/174))

## v0.1.106 — 2026-10-04

- Record the published body so a merge artifact cannot lock in (H2) ([#171](https://github.com/SpecDriven/specdriven-app/pull/171))

## v0.1.105 — 2026-10-04

- Maintenance release.

## v0.1.104 — 2026-10-04

- A folder named features or tasks no longer steals those urls ([#168](https://github.com/SpecDriven/specdriven-app/pull/168))

## v0.1.103 — 2026-10-04

- Pin plugin folders, trust and marketplaces in demo mode ([#170](https://github.com/SpecDriven/specdriven-app/pull/170))

## v0.1.102 — 2026-10-04

- Bind loopback and guard the API's trust boundary ([#169](https://github.com/SpecDriven/specdriven-app/pull/169))
- Lean 4 verification of the sync core ([#164](https://github.com/SpecDriven/specdriven-app/pull/164))
- Catch stale nested installs; fix plugin watch test race ([#167](https://github.com/SpecDriven/specdriven-app/pull/167))
- Name the spec folder in specdriven:// deep links ([#165](https://github.com/SpecDriven/specdriven-app/pull/165))
- Clear bun audit findings ([#166](https://github.com/SpecDriven/specdriven-app/pull/166))
- License specdriven.app under PolyForm Perimeter 1.0.1 ([#162](https://github.com/SpecDriven/specdriven-app/pull/162))

## v0.1.101 — 2026-10-02

- Folder switch waits for in-flight saves, and a queued scenario save lands where the tick placed it ([#161](https://github.com/SpecDriven/specdriven-app/pull/161))
- Add dev:debug script and a dev-only Debug menu for the Electron main process ([#160](https://github.com/SpecDriven/specdriven-app/pull/160))

## v0.1.100 — 2026-10-02

- Page saves and netsync keep unabsorbed disk edits, without doubling them ([#159](https://github.com/SpecDriven/specdriven-app/pull/159))

## v0.1.98 — 2026-10-02

- Dedupe Automerge and CodeMirror; clear bun audit ([#158](https://github.com/SpecDriven/specdriven-app/pull/158))

## v0.1.97 — 2026-10-02

- Maintenance release.

## v0.1.96 — 2026-10-02

- Features head icons for New folder, New feature and Start session ([#157](https://github.com/SpecDriven/specdriven-app/pull/157))

## v0.1.95 — 2026-09-25

- An editor save absorbs un-absorbed disk edits instead of overwriting them ([#148](https://github.com/SpecDriven/specdriven-app/pull/148))
- A status change can no longer demote a published scenario (specs/ui.spec.md) ([#149](https://github.com/SpecDriven/specdriven-app/pull/149))

## v0.1.94 — 2026-09-25

- Observability page — browse, search and set log verbosity ([#147](https://github.com/SpecDriven/specdriven-app/pull/147))
- Keep published scenarios published, and keep disk edits an autosave races ([#150](https://github.com/SpecDriven/specdriven-app/pull/150))

## v0.1.93 — 2026-09-23

- Maintenance release.

## v0.1.92 — 2026-09-23

- The demo installs the Event Models from the marketplace at start (specs/app/plugins.feature.md) ([#146](https://github.com/SpecDriven/specdriven-app/pull/146))

## v0.1.91 — 2026-09-23

- Maintenance release.

## v0.1.90 — 2026-09-23

- The Linux install builds only the host's AppImage (specs/app/installation.feature.md) ([#145](https://github.com/SpecDriven/specdriven-app/pull/145))

## v0.1.89 — 2026-09-23

- Maintenance release.

## v0.1.88 — 2026-09-23

- Marketplaces section groups each marketplace with its plugins ([#144](https://github.com/SpecDriven/specdriven-app/pull/144))

## v0.1.87 — 2026-09-23

- The Event Models move out of the app into the plugin marketplace ([#143](https://github.com/SpecDriven/specdriven-app/pull/143))

## v0.1.86 — 2026-09-23

- Renaming a page renames its file (#122) ([#134](https://github.com/SpecDriven/specdriven-app/pull/134))
- Settings and Plugins as pages in the editor pane (specs/user-info-settings.feature.md) ([#142](https://github.com/SpecDriven/specdriven-app/pull/142))
- The plugin marketplace — index, consent install, update, remove (specs/app/plugins.feature.md) ([#141](https://github.com/SpecDriven/specdriven-app/pull/141))
- Plugins from local folders — discovery, build, bundle route, watch and CLI (specs/app/plugins.feature.md) ([#140](https://github.com/SpecDriven/specdriven-app/pull/140))

## v0.1.85 — 2026-09-22

- The plugins profile and Settings → Plugins (specs/app/plugins.feature.md) ([#139](https://github.com/SpecDriven/specdriven-app/pull/139))
- Roadmap, Tasks and Notebook as built-in plugins (specs/app/plugins.feature.md) ([#138](https://github.com/SpecDriven/specdriven-app/pull/138))
- Event Models as a built-in plugin (specs/app/plugins.feature.md) ([#137](https://github.com/SpecDriven/specdriven-app/pull/137))
- The Issues tab as a built-in plugin (specs/app/plugins.feature.md) ([#136](https://github.com/SpecDriven/specdriven-app/pull/136))

## v0.1.84 — 2026-09-22

- Plugin kernel, and the Tests tab as the first built-in plugin (specs/app/plugins.feature.md) ([#135](https://github.com/SpecDriven/specdriven-app/pull/135))

## v0.1.83 — 2026-09-18

- Turn every demo module on by default (specs/app/tasks.feature.md) ([#133](https://github.com/SpecDriven/specdriven-app/pull/133))

## v0.1.82 — 2026-09-17

- Hide the editor pane from an icon (specs/ui/ui.feature.md) ([#132](https://github.com/SpecDriven/specdriven-app/pull/132))

## v0.1.81 — 2026-09-16

- Add a task to Google Calendar (specs/app/tasks.feature.md) ([#131](https://github.com/SpecDriven/specdriven-app/pull/131))

## v0.1.80 — 2026-09-16

- Anchor the entity-field list to the @ it completes (specs/editor/data-model-integration-in-editor.feature.md) ([#130](https://github.com/SpecDriven/specdriven-app/pull/130))

## v0.1.79 — 2026-09-15

- Complete entity fields after @ in the editor (specs/editor/data-model-integration-in-editor.feature.md) ([#129](https://github.com/SpecDriven/specdriven-app/pull/129))

## v0.1.78 — 2026-09-15

- Link related pull requests to features and scenarios (specs/external-links/related-pull-requests.feature.md) ([#128](https://github.com/SpecDriven/specdriven-app/pull/128))

## v0.1.77 — 2026-09-14

- Manage and switch spec folders (specs/app/spec-folders.feature.md) ([#127](https://github.com/SpecDriven/specdriven-app/pull/127))

## v0.1.76 — 2026-09-13

- Mirror the data repo's folders under .specdriven/automerge (specs/datastore/automerge-store.feature.md) ([#126](https://github.com/SpecDriven/specdriven-app/pull/126))

## v0.1.75 — 2026-09-13

- Import .excalidraw files into the editor (specs/editor/excalidraw-support.feature.md) ([#125](https://github.com/SpecDriven/specdriven-app/pull/125))

## v0.1.74 — 2026-09-13

- Open test links in IntelliJ IDEA (specs/traceability.feature.md) ([#123](https://github.com/SpecDriven/specdriven-app/pull/123))

## v0.1.73 — 2026-09-12

- The desktop header's icons were dragging the window, not clicking ([#121](https://github.com/SpecDriven/specdriven-app/pull/121))

## v0.1.72 — 2026-09-12

- The engineering notebook, a shared dated log of observations and decisions ([#120](https://github.com/SpecDriven/specdriven-app/pull/120))

## v0.1.71 — 2026-09-12

- Make the Pomodoro an opt-in pane behind a header icon ([#119](https://github.com/SpecDriven/specdriven-app/pull/119))
- Make the git fixtures ~100x cheaper ([#118](https://github.com/SpecDriven/specdriven-app/pull/118))
- Land the feature description before switching data folder ([#116](https://github.com/SpecDriven/specdriven-app/pull/116))

## v0.1.70 — 2026-09-12

- Make the Pomodoro a feature of the app, not a kind of session ([#117](https://github.com/SpecDriven/specdriven-app/pull/117))

## v0.1.69 — 2026-09-12

- Show a feature's scenarios in the sidebar tree ([#115](https://github.com/SpecDriven/specdriven-app/pull/115))

## v0.1.68 — 2026-09-11

- Turn Excalidraw on by default in the demo ([#113](https://github.com/SpecDriven/specdriven-app/pull/113))

## v0.1.67 — 2026-09-11

- Maintenance release.

## v0.1.66 — 2026-09-11

- Edit an Excalidraw diagram already in the text ([#112](https://github.com/SpecDriven/specdriven-app/pull/112))

## v0.1.65 — 2026-09-11

- Seal the Event Model canvas on flush so no save reaches the new folder ([#107](https://github.com/SpecDriven/specdriven-app/pull/107))

## v0.1.64 — 2026-09-11

- Re-land the Electron 43.7 revert (startup bus error) ([#110](https://github.com/SpecDriven/specdriven-app/pull/110))
- Add electron-crash-test skill: build the desktop app and restart it 3 times ([#111](https://github.com/SpecDriven/specdriven-app/pull/111))

## v0.1.63 — 2026-09-11

- Size images from the Markdown editor's Preview ([#109](https://github.com/SpecDriven/specdriven-app/pull/109))

## v0.1.62 — 2026-09-11

- Resizable feature description editor that opens on Preview ([#108](https://github.com/SpecDriven/specdriven-app/pull/108))

## v0.1.61 — 2026-09-10

- Earlier changes are in the git history.
