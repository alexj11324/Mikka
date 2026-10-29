# Project skills

These are vendored community Agent Skills, checked into the repository so
Claude Code (and other compatible agents) see the same operating standards on
every clone. They are used as review and implementation checklists; they are
not application runtime code.

Vendored on 2026-10-29 from these pinned commits:

| Source | Commit | License | Vendored skills |
| --- | --- | --- | --- |
| [obra/superpowers](https://github.com/obra/superpowers) | `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b` | MIT | All 15 skills under `skills/` |
| [AllThingsSmitty/proven-skills](https://github.com/AllThingsSmitty/proven-skills) | `5b74885f7e0568565c04534831cb73eaffd4c0e4` | MIT | `debug`, `incident`, `perf`, `security`, `db-review`, `arch-review`, `node-ops` |
| [param087/saas-ui-skills](https://github.com/param087/saas-ui-skills) | `4017eaf1e1167a56a5271839053d888faeb1f44a` | MIT | All 15 SaaS UI skills |
| [mbennell/claude-field-kit](https://github.com/mbennell/claude-field-kit) | `58da5e874ccb5261fd41af75c1d2c12456e36017` | MIT | `saas-design` |
| [anthropics/skills](https://github.com/anthropics/skills) | `ca45fc496a3436251f191354091d557da31c15b5` | Apache-2.0 | `frontend-design` |

Full license texts are in [`../skill-licenses/`](../skill-licenses/).

## Which skill to use

- **Any bug or failing test**: `systematic-debugging` first (root cause before
  fixes). Use `debug` as a second framing checklist; do not propose a fix while
  the root cause is still unknown.
- **Production incident**: `incident` (triage, blast radius, mitigation,
  communication, post-mortem), then `systematic-debugging`.
- **Performance work**: `perf`; use `node-ops` for Next.js/Node production
  readiness and `db-review` for Postgres queries and indexes.
- **Architecture / security review**: `arch-review`, `security`.
- **Settings UI**: `settings-pages` is the primary IA/save-model checklist.
  `forms-and-validation`, `empty-and-loading-states`, `accessible-components`,
  `design-tokens-theming` and `navigation-patterns` cover the details.
- **Broader SaaS UI**: `saas-design` (component patterns) and
  `frontend-design` (visual direction/craft).
- **Writing or reviewing a skill**: `writing-skills`. It is the standard used
  for the skill audit; run the validator and the trigger/no-trigger checks it
  describes before accepting a new skill.

## Operating rules

1. Read the skill's `SKILL.md` before using it; references are loaded on
   demand.
2. Skills may contain scripts. They are not run by the application, CI or
   install process. Inspect a script before executing it, and never let it
   read production credentials or customer data.
3. A skill is guidance, not authority to bypass repository rules: the isolated
   `_e2e` database, secret handling, one Settings surface, UI policy and
   release process still apply.
4. To update a skill, replace the whole directory from the upstream pinned
   commit, update the table above, and rerun the skill audit.
