# Paid blocks and components are used as shipped

- Date: 2026-11-09 00:50 UTC
- Source: Alex, relayed by the coordinator session: 「原样使用，只换数据」. "Use paid blocks and components as they ship. Change only the data and the text strings. Keep their icons, avatars, logos, layout, spacing, density, colours, typography, borders and motion."
- Rule: scopes `style/semantic-colors` and `typography/preset-only` (rules.md colour and type rules) and the copy-structure part of copy.md to Mikka-owned UI; adds the PR-template side-by-side item.
- Replaces: —

## What changes

A paid block or component (BoardUI Pro, affectUI, beUI Pro) keeps its native
look. In our use we change only:

- the data it renders, and
- its text strings, which still go through i18n (`messages/*.json`) and still
  follow copy.md wording rules (C-02, C-03, C-04, R-40, R-43, R-44).

We keep its icons, avatars, logos, layout, spacing, density, colours,
typography, borders and motion. No re-theming to Mikka tokens, no swapping an
icon for text, no removing a visual element. Any of those needs Alex's approval,
recorded in the PR.

## Conflicts with other rules

Where a repository rule would restyle a block (semantic tokens only, composite
or preset type only, "the template keeps its look" read as "make it look like
Mikka", copy structure such as dropping an eyebrow or a badge), **the native
look wins**. Record the conflict in the PR instead of restyling.

The exemption covers, by explicit path list:

- vendored paid sources, and
- their direct use sites: files whose job is to render a paid block with our
  data and strings.

It covers only the raw-palette (`style/semantic-colors`), type-utility
(`typography/preset-only`) and copy-structure rules. Text strings still go
through i18n. Every other rule still applies, and every security, secret and
paid-source guard stays as it is: paid source never enters this repository or
its images, licence keys never enter a commit, PR, issue or log, and paid
screenshots go only on private pages.

Where the lists live:

- This repository: `ui-policy.json` → `asShipped.public`. `lint:ui` drops the
  two style rules for files under those paths. It is empty today: paid source
  is not allowed here, and the free vendored roots are already outside
  `lint:ui` through `componentRoots`.
- The hosted repository (private): `AGENTS.md`, section 「原样使用，只换数据」,
  lists the vendored roots and use sites. No script there checks palette or type;
  the rules it scopes are the written BoardUI rules in `AGENTS.md` and
  `.claude/skills/boardui/SKILL.md`.

## Review

Every UI PR that adds or changes a paid block attaches a side-by-side of the
library demo and our use, and lists any visual difference beyond data and text,
with its reason. The PR template carries the item. Paid screenshots go on a
private page, never in the PR body.

Past drift on existing surfaces is listed separately and is not changed by this
decision; each fix is its own PR with the side-by-side.
