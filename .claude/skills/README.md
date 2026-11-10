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
No skill restyles a paid block or component (BoardUI Pro, affectUI, beUI Pro):
their token, icon-set, font and polish rules apply to Mikka's own UI only
(`docs/design/decisions/2026-11-09-0050-paid-blocks-as-shipped.md`).

Vendored on 2026-10-29, unmodified, from these pinned commits:

| Source | Commit | License | Skills |
| --- | --- | --- | --- |
| [AllThingsSmitty/proven-skills](https://github.com/AllThingsSmitty/proven-skills) | `5b74885f7e0568565c04534831cb73eaffd4c0e4` | MIT, (c) 2026 Matt Smith | `debug`, `incident`, `perf`, `node-ops`, `security`, `db-review` |
| [param087/saas-ui-skills](https://github.com/param087/saas-ui-skills) | `4017eaf1e1167a56a5271839053d888faeb1f44a` | MIT, (c) 2026 Param Bhavsar | `settings-pages` |
| [Dammyjay93/interface-design](https://github.com/Dammyjay93/interface-design) | `2f9be3206855bcb2d1d0af262c8bae25cba6658d` | MIT, (c) 2026 Damola Akinleye | `interface-design`, commands `interface-design:design-review` and `interface-design:design-deslop` (vendored 2026-10-31) |
| [heydamir/unslop](https://github.com/heydamir/unslop) | `4652254daff586ff4739849395a127b56f7f8cc7` | CC BY 4.0, by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)) | `unslop` (vendored 2026-10-31). Changed: upstream `scripts/` (`snapshot.mjs`, `story.mjs`) left out under the no-scripts rule below, so the live-site snapshot and story-video steps in `SKILL.md` do not run here; every other file is unmodified |
| [uizze.sh](https://uizze.sh/.well-known/skills/index.json) (skills.sh listing `uizze.sh/ios-design`) | fetched 2026-10-31, checksums in `CHECKSUMS.sha256` | Apache-2.0 with MIT notices (`LICENSE`, `NOTICE`) | `ios-design` (vendored 2026-10-31 at Alex's request). Changed: `scripts/verify-visual-evidence.mjs` left out under the no-scripts rule below; every other file is unmodified |
| [mattpocock/skills](https://github.com/mattpocock/skills) | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | MIT, (c) 2026 Matt Pocock | Vendored 2026-11-02 at Alex's request, flattened from `skills/<group>/<name>/`: `ask-matt`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-me`, `grill-with-docs`, `grilling`, `handoff`, `implement`, `implement-spec`, `improve-codebase-architecture`, `loop-me`, `pr`, `prototype`, `research`, `retro`, `software-factory`, `tdd`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`, `writing-beats`, `writing-for-agents`, `writing-fragments`, `writing-shape`. Removed later as irrelevant to Mikka (2026-11-03): `migrate-to-shoehorn` (no shoehorn dependency) and `scaffold-exercises` (no course exercises). Changed: `diagnosing-bugs/scripts/hitl-loop.template.sh` left out under the no-scripts rule. Not vendored: `code-review` (same name as Claude Code's built-in skill), `git-guardrails-claude-code` (installs a hook script into settings.json), `wizard` (reads real `.env` files; ships a script template), `chief-of-staff` (acts on its own, posts to the tracker, makes unrequested repo-wide changes), `claude-handoff` (starts an unsupervised background `claude --bg`), `setup-pre-commit` (stages and commits every changed file), `setup-matt-pocock-skills` and `setup-ts-deep-modules` (write CLAUDE.md/AGENTS.md and CI config) |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `3a13158ff1f32156cbe144108de48eda2ecaed9a` | MIT, (c) 2024 Next Level Builder | `ui-ux-pro-max` (vendored 2026-11-02, from `.claude/skills/ui-ux-pro-max/`). Changed: `scripts/` (Python search over the CSVs in `data/`) and `data/` left out under the no-scripts rule, so the `search.py` steps in `SKILL.md` do not run here; use `SKILL.md` and `references/` as checklists |
| [uxcel-lab/product-skills](https://github.com/uxcel-lab/product-skills) | `5007cd0241ccaa51ae2e4681f9618912dc10e239` | MIT, (c) 2026 Uxcel Lab | `ux-information-architecture-audit` (`ux/audits/information-architecture`), `ux-navigation` (`ux/components/navigation`), `ux-settings` (`ux/screens/settings`), `ux-heuristics-audit` (`ux/audits/heuristics`), vendored 2026-11-02, unmodified. Their mentions of `docs/orchestration-policy.md` and sibling `ux-*` skills point at files not vendored; the skills say to proceed without them |
| [obra/superpowers](https://github.com/obra/superpowers) | `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b` | MIT, (c) 2025 Jesse Vincent | `systematic-debugging`, `verification-before-completion`, vendored 2026-11-03 at Alex’s request. Markdown files are unmodified. `find-polluter.sh` and `condition-based-waiting-example.ts` are omitted under the no-scripts rule; their references are explanatory only. Companion TDD guidance uses the existing project `tdd` skill. |
| [wondelai/skills](https://github.com/wondelai/skills) | `d8d5d75f83da9f16d8aad5bab5f5b341a4770a30` | MIT, (c) 2025 Wondel.ai sp. z o.o. | `ux-heuristics` (vendored 2026-11-04 at Alex's request), unmodified. Krug's "Don't Make Me Think" laws plus Nielsen's 10 heuristics, with severity ratings and a 10-point score. Its book links and mentions of sibling skills (`refactoring-ui`, `cro-methodology`) are references only; those skills were not vendored |
| [mastepanoski/claude-skills](https://github.com/mastepanoski/claude-skills) | `ac3023830834f9c7c181649f31fbfd48c91837d3` | MIT, (c) 2026 mastepanoski | `cognitive-walkthrough` (`skills/cognitive-walkthrough/`, vendored 2026-11-04 at Alex's request), unmodified. Its mentions of sibling skills (Nielsen Heuristics, Don Norman Principles, WCAG Accessibility) point at skills not vendored; use `ux-heuristics` / `ux-heuristics-audit` instead |
| [expo/skills](https://github.com/expo/skills) | `a9e5bd3fa00b4e61f632e43f85da73aee1942582` | MIT, (c) 2025-present 650 Industries, Inc. (Expo); `expo-animation` also MIT, (c) 2026 Emil Kowalski (its own `LICENSE`) | `expo-overview`, `expo-native-ui`, `expo-animation`, `expo-ui`, `expo-router`, `expo-design-system`, vendored 2026-11-05 at Alex's request from `plugins/expo/skills/`, unmodified. Changed: `expo-ui/scripts/list-components.js` left out under the no-scripts rule; to list `@expo/ui` components, read the installed package's `.d.ts` files as its `references/swift-ui.md` also says. Their mentions of sibling skills not vendored here (`expo-project-structure`, `expo-data-fetching`, `eas-app-stores`, `eas-simulator`, …) are references only; `eas-simulator` was left out because iOS changes are checked on Alex's phone after each OTA, not on a cloud simulator |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` | MIT (declared in the skill's frontmatter; the repository ships no `LICENSE` file) | `react-native-skills` (`skills/react-native-skills/`), vendored 2026-11-05 at Alex's request, unmodified |
| [warpdotdev/common-skills](https://github.com/warpdotdev/common-skills) | `8792394ff1b655e0af451b8fabb68ef0cfcbd208` | MIT, (c) 2026 Denver Technologies, Inc. | `merge-risk` (vendored 2026-11-06 from `.agents/skills/merge-risk/SKILL.md`, unmodified; five-dimensional PR merge-risk review, no scripts) |
| [avdlee/swiftui-agent-skill](https://github.com/avdlee/swiftui-agent-skill) | `62bd760f005093d1e2e4de5db156e456a5f96400` | MIT, (c) 2026 Antoine van der Lee | `swiftui-expert-skill` (vendored 2026-11-08 at Alex's request, from `skills/swiftui-expert-skill/`). Changed: `scripts/` (the Instruments `record_trace.py` / `analyze_trace.py` helpers and `instruments_parser/`) left out under the no-scripts rule, so the trace recording and analysis steps in `SKILL.md` do not run here; every other file is unmodified |
| [gannonh/skills](https://github.com/gannonh/skills) | `2ef000341d4e60af00e8934ba1d4cfef82b63b13` | MIT, (c) 2026 Gannon Hall | `update-docs` (`skills/update-docs/`, vendored 2026-11-08), unmodified. The optional `documentation-and-adrs` reference uses an available installed skill when relevant |
| [wondelai/skills](https://github.com/wondelai/skills) | `6621b1f32cca2b9b17d7a18c076bf6e7da83f8a6` | MIT, (c) 2025 Wondel.ai sp. z o.o. Google guide attribution is retained in `SKILL.md` | `technical-documentation` (vendored 2026-11-08), unmodified, including all seven reference pages |

Full license texts are in [`../skill-licenses/`](../skill-licenses/). The
`update-docs` license is retained in [`update-docs/LICENSE.md`](update-docs/LICENSE.md).

## Which skill to use

- **Documentation updates** use `update-docs` to discover affected pages and
  `technical-documentation` to check facts, structure and writing. Use the
  existing `writing-for-agents` for Agent instructions. Start with
  `docs/README.md` and preserve Mikka's document ownership. `AGENTS.md` routes
  Codex and other coding agents to the same vendored files.

- **UI design and review**: `interface-design`, with
  `/interface-design:design-review` (craft review with a pass bar) and
  `/interface-design:design-deslop` (diff-scoped cleanup). Its design-system
  file is `docs/design/`: record decisions in `docs/design/decisions/`
  instead of `.interface-design/system.md`.
- **AI-looking UI**: `unslop` as an audit list (`references/signs.md`). Mikka
  already has a direction (`docs/design/`), so use its polish mode: fix the
  signs it finds and keep Mikka's palette, Geist and layout, as its own
  tokens page says to do for a project with a working system.

- **iOS app UI follows `swiftui-expert-skill`** (Alex, 2026-11-08: 「遵守这个的规范进行开发」). Load it for every iOS UI change in `apps/mobile`, together with the Expo skills below. It is the binding standard for:
  - every SwiftUI tree the app draws through `@expo/ui/swift-ui` (`*.ios.tsx`: `Host`, menus, segmented controls, symbols, the chat header) and any native Swift module: its Operating Rules, `references/latest-apis.md` (no hard-deprecated APIs), `#available` gating with fallbacks, `Button` for every tappable element with accessibility labels;
  - native iOS behaviour and look in React Native screens too: toolbars (`references/toolbar-patterns.md`), sheets and navigation (`references/sheet-navigation-patterns.md`), lists and scrolling (`references/list-patterns.md`, `references/scroll-patterns.md`), layout and safe areas (`references/layout-best-practices.md`), Liquid Glass (`references/liquid-glass.md`; Mikka uses it for the floating header buttons and tab bar per the 2026-11-08 Comma-style header decision), accessibility and localization.
  Where it and an Expo skill disagree on how to build something inside Expo / React Native, the Expo skill decides the mechanism and this skill decides the native iOS result. `docs/design/` still decides Mikka's product rules.
- **iOS app UI** (`apps/mobile`): load `expo-overview` first and the Expo skills it routes to (`expo-native-ui`, `expo-router`, `expo-animation`, `expo-ui`, `expo-design-system`), with `react-native-skills` for list, animation and UI patterns. An iOS UI PR carries Expo Web screenshots and a checklist of what Alex checks on TestFlight after the OTA. `ios-design` stays a review checklist (native controls first, gestures as springs, keyboard through `react-native-keyboard-controller`); its Uizze MCP steps are optional and not connected here. Where it and the Expo skills differ on how to build something in Expo, the Expo skills decide.

- **Flow usability (glanceable, simple user flow)**: before a design or UI change is handed in, run `ux-heuristics` (score every screen out of 10; below 8 is not ready) and `cognitive-walkthrough` on each key task, counting clicks, scrolls and page switches per step. Report both results with the design. The author's own score is only a reference: the review that decides is done by an independent reviewer that did not author the design, against full-size screenshots and the live product, and it also checks R-84 to R-90 in `docs/design/rules.md` (Design review) one by one, including R-90: every part reuses an existing component.
- **Product UX checks**: `ux-heuristics-audit`, `ux-information-architecture-audit`, `ux-navigation`, `ux-settings` (with `settings-pages`); `ui-ux-pro-max` references as a UI checklist. `docs/design/` and `interface-design` still decide.
- **Planning and design of code**: `grill-me` / `grill-with-docs` (interview before building), `domain-modeling`, `codebase-design`, `improve-codebase-architecture`, `prototype`, `tdd`, `to-spec`, `to-tickets`. `handoff` for a session summary. Skills that post to GitHub (`to-spec`, `to-tickets`, `triage`, `wayfinder`, `implement-spec`) follow `AGENTS.md` and the session's own GitHub rules; `triage` never runs an external PR's code without approval, and `wayfinder` asks for approval before pushing any branch.

- **Bug, failing test or blocked task flow**: `systematic-debugging` (evidence at each component boundary, root cause, one hypothesis and a failing regression before the fix). `debug` is the shorter checklist; `diagnosing-bugs` is another detailed reference.
- **PR merge-risk assessment**: `merge-risk` reviews a PR's actual diff, source issue, verification evidence, reversibility, and error detection before merge. Record the five verdicts and actionable gaps in the PR. The risk grade is advisory: neither low risk nor this skill bypasses CI, production acceptance, security rules, or the PR owner's merge responsibilities. Treat the PR description as a claim to verify, not evidence.
- **Before claiming a fix or completion**: `verification-before-completion`. Read the actual command/API result and exit status, verify each requirement and report remaining gaps. Reuse valid commit-bound CI and fixed-environment evidence as `AGENTS.md` permits; rerun affected checks when code or environment changes.
- **Production incident**: `incident`, then `debug`.
- **Performance / production readiness**: `perf`, `node-ops`; `db-review` for
  Postgres queries, indexes and migrations.
- **Trust-boundary review**: `security`.
- **Settings**: `settings-pages` for section structure, save model, unsaved
  changes and destructive confirmations. It mentions sibling skills
  (`forms-and-validation`, `data-tables`, `modals-and-dialogs`,
  `billing-and-pricing`) that were deliberately not vendored.

Why the other skills were removed was recorded in the 2026-10-29 SaaS skill review (deleted 2026-11-03; see git history).

## Updating

Replace a whole skill directory from a new pinned upstream commit, update the
table above, and keep the upstream license in `../skill-licenses/`. Do not add
a skill that ships executable scripts or tells the agent to invoke skills
unconditionally.
