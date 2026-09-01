# Skills for user's AI agents to facilitate working with Specdriven App

Portable agent skills in the standard Anthropic layout: each skill is a
directory with a `SKILL.md` (YAML `name` + `description` frontmatter, then
instructions) and a `references/` folder the agent loads on demand.

To use one, copy its directory into the skills location your coding agent
reads — e.g. `.claude/skills/` in the repo the agent works in, or
`~/.claude/skills/` for all sessions — or point the agent at the directory
directly. The skills are self-contained: they need nothing from this app
repo at runtime.

## Skills

| Skill | What it does |
| ----- | ------------ |
| [convert-specs-to-specdriven](convert-specs-to-specdriven/SKILL.md) | Converts specs from other formats — Gherkin/Cucumber `.feature` files, Markdown PRDs, Jira/tracker exports — into SpecDriven `.feature.md` files. Its [references/grammar.md](convert-specs-to-specdriven/references/grammar.md) is the complete standalone reference for the `.feature.md` format. |
