# Project skills

Vendored community Agent Skills, used as review and implementation checklists.
They are not application runtime code and contain no scripts. `AGENTS.md`,
`docs/design/` (including R-40 and the one Settings surface) and the release
and test rules always win over a skill; the example code and copy in a skill
are illustrations, not Mikka's components or wording.

Vendored on 2026-10-29, unmodified, from these pinned commits:

| Source | Commit | License | Skills |
| --- | --- | --- | --- |
| [AllThingsSmitty/proven-skills](https://github.com/AllThingsSmitty/proven-skills) | `5b74885f7e0568565c04534831cb73eaffd4c0e4` | MIT, (c) 2026 Matt Smith | `debug`, `incident`, `perf`, `node-ops`, `security`, `db-review` |
| [param087/saas-ui-skills](https://github.com/param087/saas-ui-skills) | `4017eaf1e1167a56a5271839053d888faeb1f44a` | MIT, (c) 2026 Param Bhavsar | `settings-pages` |
| [Dammyjay93/interface-design](https://github.com/Dammyjay93/interface-design) | `2f9be3206855bcb2d1d0af262c8bae25cba6658d` | MIT, (c) 2026 Damola Akinleye | `interface-design`, commands `interface-design:design-review` and `interface-design:design-deslop` (vendored 2026-10-31) |

Full license texts are in [`../skill-licenses/`](../skill-licenses/).

## Which skill to use

- **UI design and review**: `interface-design`, with
  `/interface-design:design-review` (craft review with a pass bar) and
  `/interface-design:design-deslop` (diff-scoped cleanup). Its design-system
  file is `docs/design/`: record decisions in `docs/design/decisions.md`
  instead of `.interface-design/system.md`.

- **Bug or failing test**: `debug` (root cause before a fix).
- **Production incident**: `incident`, then `debug`.
- **Performance / production readiness**: `perf`, `node-ops`; `db-review` for
  Postgres queries, indexes and migrations.
- **Trust-boundary review**: `security`.
- **Settings**: `settings-pages` for section structure, save model, unsaved
  changes and destructive confirmations. It mentions sibling skills
  (`forms-and-validation`, `data-tables`, `modals-and-dialogs`,
  `billing-and-pricing`) that were deliberately not vendored.

Why the other skills were removed is recorded in
[`docs/audits/2026-10-29-saas-skill-review.md`](../../docs/audits/2026-10-29-saas-skill-review.md).

## Updating

Replace a whole skill directory from a new pinned upstream commit, update the
table above, and keep the upstream license in `../skill-licenses/`. Do not add
a skill that ships executable scripts or tells the agent to invoke skills
unconditionally.
