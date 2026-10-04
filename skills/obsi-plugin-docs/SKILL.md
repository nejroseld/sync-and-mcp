---
name: obsi-plugin-docs
description: Keep Obsi Sync plugin documentation accurate whenever a user-facing feature, setting, workflow, or behavior is added or changed in this repository.
---

# Keep plugin documentation current

Use this skill while implementing or changing an Obsi Sync feature. Treat documentation as part of the feature, completed in the same task.

1. Read the relevant part of `docs/PLUGIN.md` before editing behavior. Read `docs/ARCHITECTURE.md`, `docs/CODEMAP.md`, or `docs/API.md` only if the change affects their subjects.
2. After implementation, update `docs/PLUGIN.md` so a user can understand the resulting behavior without reading code. Cover the entry point, steps, defaults, prerequisites, data or security implications, and migration or failure behavior when relevant. Update `README.md` only when its quick start or summary changes.
3. If a public HTTP or MCP contract changes, update `docs/API.md`. If modules or data flow change, update `docs/ARCHITECTURE.md` or `docs/CODEMAP.md` as needed. Keep each fact in its canonical document and link instead of copying long sections.
4. Check labels against both English source strings and `src/locales/ru.ts`. Use user-facing Russian names in the guide, adding English labels only when they help locate a control.
5. Before finishing, compare the diff with the documentation: every new or changed user-facing behavior should have a corresponding explanation. Run `git diff --check`; run code checks appropriate to the feature. Report any documentation gap explicitly if it cannot be resolved.

For internal refactors with no behavioral or operational change, inspect the docs and leave them untouched if they remain accurate. Do not invent capabilities or document planned behavior as implemented.
