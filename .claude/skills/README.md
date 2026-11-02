# Project skills

Vendored community Agent Skills, used as review and implementation checklists.
They are not application runtime code and contain no scripts. `AGENTS.md`
and the release and test rules always win over a skill. For product and visual
rules the two design skills (`unslop`, `interface-design`) win over an R-rule
by default (decision 2026-10-31): change the code, the R-entry in
`docs/design/rules.md` and its `lint:ui` / `check-copy` check together. The
exception is a skill rule that does not fit a dense SaaS product (marketing
hero type, decorative motion, big whitespace in data views); skip it and say
why. Where the two skills disagree, `interface-design` decides. A skill audit
never changes the shell layout (R-35), and the generated gradient avatar for
people is intentional (R-36). The example
code and copy in a skill are illustrations, not Mikka's components or wording.

Vendored on 2026-10-29, unmodified, from these pinned commits:

| Source | Commit | License | Skills |
| --- | --- | --- | --- |
| [AllThingsSmitty/proven-skills](https://github.com/AllThingsSmitty/proven-skills) | `5b74885f7e0568565c04534831cb73eaffd4c0e4` | MIT, (c) 2026 Matt Smith | `debug`, `incident`, `perf`, `node-ops`, `security`, `db-review` |
| [param087/saas-ui-skills](https://github.com/param087/saas-ui-skills) | `4017eaf1e1167a56a5271839053d888faeb1f44a` | MIT, (c) 2026 Param Bhavsar | `settings-pages` |
| [Dammyjay93/interface-design](https://github.com/Dammyjay93/interface-design) | `2f9be3206855bcb2d1d0af262c8bae25cba6658d` | MIT, (c) 2026 Damola Akinleye | `interface-design`, commands `interface-design:design-review` and `interface-design:design-deslop` (vendored 2026-10-31) |
| [heydamir/unslop](https://github.com/heydamir/unslop) | `4652254daff586ff4739849395a127b56f7f8cc7` | CC BY 4.0, by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)) | `unslop` (vendored 2026-10-31). Changed: upstream `scripts/` (`snapshot.mjs`, `story.mjs`) left out under the no-scripts rule below, so the live-site snapshot and story-video steps in `SKILL.md` do not run here; every other file is unmodified |
| [uizze.sh](https://uizze.sh/.well-known/skills/index.json) (skills.sh listing `uizze.sh/ios-design`) | fetched 2026-10-31, checksums in `CHECKSUMS.sha256` | Apache-2.0 with MIT notices (`LICENSE`, `NOTICE`) | `ios-design` (vendored 2026-10-31 at Alex's request). Changed: `scripts/verify-visual-evidence.mjs` left out under the no-scripts rule below; every other file is unmodified |
| [mattpocock/skills](https://github.com/mattpocock/skills) | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | MIT, (c) 2026 Matt Pocock | Vendored 2026-11-02 at Alex's request, flattened from `skills/<group>/<name>/`: `ask-matt`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-me`, `grill-with-docs`, `grilling`, `handoff`, `implement`, `implement-spec`, `improve-codebase-architecture`, `loop-me`, `migrate-to-shoehorn`, `pr`, `prototype`, `research`, `retro`, `scaffold-exercises`, `software-factory`, `tdd`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`, `writing-beats`, `writing-for-agents`, `writing-fragments`, `writing-shape`. Changed: `diagnosing-bugs/scripts/hitl-loop.template.sh` left out under the no-scripts rule. Not vendored: `code-review` (same name as Claude Code's built-in skill), `git-guardrails-claude-code` (installs a hook script into settings.json), `wizard` (reads real `.env` files; ships a script template), `chief-of-staff` (acts on its own, posts to the tracker, makes unrequested repo-wide changes), `claude-handoff` (starts an unsupervised background `claude --bg`), `setup-pre-commit` (stages and commits every changed file), `setup-matt-pocock-skills` and `setup-ts-deep-modules` (write CLAUDE.md/AGENTS.md and CI config) |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `3a13158ff1f32156cbe144108de48eda2ecaed9a` | MIT, (c) 2024 Next Level Builder | `ui-ux-pro-max` (vendored 2026-11-02, from `.claude/skills/ui-ux-pro-max/`). Changed: `scripts/` (Python search over the CSVs in `data/`) and `data/` left out under the no-scripts rule, so the `search.py` steps in `SKILL.md` do not run here; use `SKILL.md` and `references/` as checklists |
| [uxcel-lab/product-skills](https://github.com/uxcel-lab/product-skills) | `5007cd0241ccaa51ae2e4681f9618912dc10e239` | MIT, (c) 2026 Uxcel Lab | `ux-information-architecture-audit` (`ux/audits/information-architecture`), `ux-navigation` (`ux/components/navigation`), `ux-settings` (`ux/screens/settings`), `ux-heuristics-audit` (`ux/audits/heuristics`), vendored 2026-11-02, unmodified. Their mentions of `docs/orchestration-policy.md` and sibling `ux-*` skills point at files not vendored; the skills say to proceed without them |

Full license texts are in [`../skill-licenses/`](../skill-licenses/).

## Which skill to use

- **UI design and review**: `interface-design`, with
  `/interface-design:design-review` (craft review with a pass bar) and
  `/interface-design:design-deslop` (diff-scoped cleanup). Its design-system
  file is `docs/design/`: record decisions in `docs/design/decisions/`
  instead of `.interface-design/system.md`.
- **AI-looking UI**: `unslop` as an audit list (`references/signs.md`). Mikka
  already has a direction (`docs/design/`), so use its polish mode: fix the
  signs it finds and keep Mikka's palette, Geist and layout, as its own
  tokens page says to do for a project with a working system.

- **iOS app UI** (`apps/mobile`): `ios-design`. Native controls first, gestures as springs, keyboard through `react-native-keyboard-controller`. Its Uizze MCP steps are optional and not connected here.

- **Product UX checks**: `ux-heuristics-audit`, `ux-information-architecture-audit`, `ux-navigation`, `ux-settings` (with `settings-pages`); `ui-ux-pro-max` references as a UI checklist. `docs/design/` and `interface-design` still decide.
- **Planning and design of code**: `grill-me` / `grill-with-docs` (interview before building), `domain-modeling`, `codebase-design`, `improve-codebase-architecture`, `prototype`, `tdd`, `to-spec`, `to-tickets`. `handoff` for a session summary. Skills that post to GitHub (`to-spec`, `to-tickets`, `triage`, `wayfinder`, `implement-spec`) follow `AGENTS.md` and the session's own GitHub rules; `triage` never runs an external PR's code without approval, and `wayfinder` asks for approval before pushing any branch.

- **Bug or failing test**: `debug` (root cause before a fix); `diagnosing-bugs` is the longer version.
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
