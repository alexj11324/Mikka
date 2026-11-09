# Paid blocks and components are used as shipped

- Date: 2026-11-09 00:50 UTC
- Source: Alex, relayed by the coordinator session: 「原样使用，只换数据」. "Use paid blocks and components as they ship. Change only the data and the text strings. Keep their icons, avatars, logos, layout, spacing, density, colours, typography, borders and motion."
- Rule: scopes `style/semantic-colors`, `typography/preset-only` and the copy-structure part of copy.md so they never restyle a paid block; BoardUI's token rules stay for BoardUI components and Mikka's own UI; adds the PR-template side-by-side item.
- Replaces: the restyle clauses listed under "Superseded clauses" below.

## The rule

1. **Paid blocks and components** (BoardUI Pro, affectUI, beUI Pro) are used as
   shipped. In our use we change only:

   - the data it renders, and
   - its text strings, which still go through i18n (`messages/*.json`) and still
     follow copy.md wording rules (C-02, C-03, C-04, R-40, R-43, R-44).

   We keep its icons, avatars, logos, layout, spacing, density, colours,
   typography, borders and motion. No re-theming to Mikka tokens, no swapping in
   Mikka avatars, icons or components, no removing a visual element.
2. **BoardUI's own token rules** (semantic tokens, composite type utilities,
   Remix icons) stay for BoardUI components and for Mikka's own hand-written UI,
   because that is how BoardUI ships. They are never applied to affectUI or beUI
   blocks, which keep their own classes, colours, type and icons.
3. **When rules conflict, the native look wins.** Record the conflict in the PR
   instead of restyling. Exceptions only with Alex's approval, recorded in the PR.
   The one approved exception today is hiding cost.

The old wording that told agents to restyle blocks is rewritten to this rule in
the same change, not left beside it. Historical decisions keep their text; a
clause that conflicts is marked superseded with a link here.

## Checks

The exemption covers, by explicit path list:

- vendored affectUI and beUI Pro sources, and
- their direct use sites: files whose job is to render such a block with our
  data and strings.

BoardUI sources and their use sites are not exempt: BoardUI's rules are their
shipped look.

It covers only the raw-palette (`style/semantic-colors`), type-utility
(`typography/preset-only`) and copy-structure rules. Text strings still go
through i18n. Every other rule still applies, and every security, secret,
paid-source and cloud-boundary guard stays as it is: paid source never enters
this repository or its images, licence keys never enter a commit, PR, issue or
log, and paid screenshots go only on private pages.

Where the lists live:

- This repository: `ui-policy.json` → `asShipped.public`. `lint:ui` drops the
  two style rules for files under those paths. It is empty today: paid source
  is not allowed here, and the free vendored roots are already outside
  `lint:ui` through `componentRoots`.
- The hosted repository (private): `AGENTS.md`, section 「原样使用，只换数据」,
  lists the affectUI and beUI roots and their use sites. No script there checks
  palette or type; the rules it scopes are the written BoardUI rules in
  `AGENTS.md`, `.cursor/rules/boardui.mdc` and the vendored skills, each of which
  now opens with a 「原样使用」 line.

## Review

Every UI PR that adds or changes a paid block attaches a side-by-side of the
library demo and our use, and lists any visual difference beyond data and text,
with its reason. The PR template carries the item. Paid screenshots go on a
private page, never in the PR body.

Past drift on existing surfaces is listed separately and is not changed by this
decision; each fix is its own PR with the side-by-side.

## Superseded clauses

Rewritten in this change, so no old wording sits beside the rule:

- This repository: the scope line at the top of `rules.md` and under its Look
  section (R-13, R-14, R-15, R-24, R-25, R-30 to R-39, R-36, R-40, R-52,
  R-71, R-74, R-75, R-80, R-90 stay Mikka's look, never applied inside a paid
  block); `README.md` source order and its notes on Comma, the design skills
  and library defaults; `components.md`; `docs/review-checklist.md`;
  `docs/settings.md`; `docs/ui-overlay.md`; `brand.md` sizes;
  `spec-template.md`; `AGENTS.md` (R-90 reuse, R-40 subtitles); `REVIEW.md`;
  `CONTRIBUTING.md` (Figma and skill review); `.claude/skills/README.md`, which
  scopes every vendored skill's token, icon-set, font and polish rules
  (`unslop`, `interface-design`, `ui-ux-pro-max`) to Mikka's own UI.
- The hosted repository: the BoardUI fence in `AGENTS.md` and
  `.cursor/rules/boardui.mdc` (components, colour, type, spacing, mechanics),
  the `boardui` skill and its theming, patterns and motion references, the
  `beui-pro` skill's "align to the project's tokens" steps, `README.md`,
  `patches/README.md` and `CLAUDE.md`.

Historical decisions keep their text and carry a "Superseded in part" line:
2026-11-01-2230 (bloub everywhere), 2026-11-07-2230 (semantic tokens on
task-state glyphs), 2026-11-01-0330 (Figma and skill review), 2026-11-01-0015
(main is the design), 2026-11-04-2230 (side by side with the live product),
2026-11-04-2320 (reuse). In the frozen `decisions.md`, the rows of 2026-10-31
(design skills win; UI consistency tags; app-wide sweep), 2026-10-30
(settings look), 2026-10-28 (grey secondary buttons) and 2026-10-23 (Comma
decides look) are annotated.

Kept as they are, because they already agree: 2026-11-06-2000,
2026-11-07-2045 (build with the real BoardUI / affectUI components),
2026-11-04-1659, and the hosted `docs/page-map.md` ("a template keeps its
look").

Past drift on hosted surfaces (re-themed tokens, hidden block parts, swapped
icons and logos) is listed for the coordinator and is not changed here.
