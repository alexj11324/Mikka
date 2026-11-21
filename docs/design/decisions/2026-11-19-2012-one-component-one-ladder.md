# One component per concept, one ladder per control family

- Date: 2026-11-19 20:12 UTC
- Source: the 2026-11-19 competitor audit, read back against our own tree. The
  badge evidence below is measured in this repository, not in the competitor.
- Rule: R-37, R-99, R-103 and R-104 stand as written; this adds the badge ladder
  (`components/ui/badge-size.ts`) and the copy and motion rules that lack a check.

## 1. One component per concept, one ladder per control family

Until today the app had two badge modules with two size scales.
`components/ui/badge.tsx` drew one badge: 20px high at 12px type.
`components/reui/badge.tsx` drew five: 16, 18, 20, 22 and 24px at 9.6, 11, 12, 12
and 13px. 29 files import the first, 17 the second, and 46 files draw a
`<Badge>`. A row mixing them had no shared baseline: both happened to have a
20px size and no other rung lined up.

The fix is `components/ui/badge-size.ts`: one map, `BADGE_SIZE`, with five rungs
read as roles (16px/`text-3xs`, 18px/`text-2xs`, 20px/`text-xs`, 22px/`text-xs`,
24px/`text-sm`). Both modules import it — `components/ui/badge.tsx` takes `size`
into its `cva` with `md` as the default, `components/reui/badge.tsx` maps its
`default` name onto `BADGE_SIZE.md`. The smallest rung reads the theme's
`--text-3xs` (10px) where the reui module had spelled `text-[0.6rem]` (9.6px): a
spelled size was the drift, so the ladder takes the token.

The rule: **a control's height, type role, padding and gap come from a named
ladder, never from the call site.** R-99 says this for the heights of `Button`,
`Input` and the selects. A badge is not a control — it is a value or a thing
named, and stands one rung below the button beside it — so it gets its own ladder
instead of borrowing `--control-*`. A component that accepts `className` is where
drift enters: two surfaces with their own `h-*`, `px-*` and `text-*` are two
ladders even when neither calls itself one.

Check: `scripts/badge-size-policy.test.mjs`. The ladder names every rung it
defines and spells no arbitrary height or type size; neither module draws a
height or an arbitrary type size of its own, and both import `BADGE_SIZE`; the
type roles the ladder reads exist in `app/globals.css`.

## 2. Copy: describe / instruct / report

- **Describe.** A line that restates the control beside it, or explains the app
  to itself, is deleted: the control already says it.
- **Instruct.** What the reader cannot act without: the reason a control is
  disabled, the next step out of a state, the consequence of a destructive
  action. Kept, and kept short.
- **Report.** Everything else is the row's content — the thing, its state, its
  count — and needs no sentence around it.

The test: if a line seems necessary, the label is what to fix. A sentence that
explains "this is where you archive it" is paying for a control labelled 确定 or a
section with no heading; fix the label and the sentence leaves.

Prose describing the app's own layout rots: it names a fact that lives elsewhere
— a panel, a position, a number of steps — and stops being true the next time
that file is edited, with no test failing.

The nearby part is written: C-04 (a hint beside a retry button does not repeat the
action), R-41 (a state names the action that resolves it), R-44 (a title names the
place or period). This adds the rest: a line that neither reports a thing nor
instructs a reader is content, and a sentence around it goes.

Check: none for the middle of it. `scripts/check-copy.mjs` decides only what a
script can decide without reading the component — labels, greetings, apologies,
exclamation marks, brands — and `scripts/copy-policy.mjs` holds the brand names.
Whether a sentence earns its place is review.

## 3. Motion touches transform, opacity and clip-path — never a size

Nothing that holds text animates width, height, padding or font-size. What it may
animate is transform, opacity or clip-path; a size reflows the text being read.

A page change does not animate. R-37 makes the right column, an open thread
taking its place, the bot list, the Artifact window and their sheets switch
instantly ([2026-11-01-2320](2026-11-01-2320-panels-open-instantly.md)); a route
change is that same event one level up and gets the same treatment.

A pane change R-37 does allow to move — a size or position the person dragged or
chose — makes what it displaces replay its journey instead of jumping. Today the
only element that does this is the segment pill, gliding on `SPRING_LAYOUT`
([2026-10-31-1814](2026-10-31-1814-segmented-control-motion.md),
`components/ui/segment-indicator.tsx`). The general shape for a displaced pane is
FLIP: draw the content from its old position to its new one rather than animating
the box around it. No FLIP helper exists here yet.

Durations and easings come from tokens, not from a file: `--motion-fast`,
`--motion-base` and `--motion-slow` in `app/globals.css` (R-103), `SPRING_LAYOUT`
and `EASE_OUT` in `lib/ease.ts`; a capture run zeroes them in one place.

Honest marking: only two property rules have a check. `motion/raw-duration`
(`scripts/motion-policy.mjs`) holds the duration ladder, and
`motion/transition-all` (`scripts/ui-policy.mjs`) fails `transition-all`, which is
how a size animation usually gets in. "Nothing holding text animates a size", "a
page change does not animate" and "a displaced element replays its journey" are
review only: no script reads what a transition does to a box.

## 4. What is mechanically enforced today, and what is not

| Rule | Enforced by | Kind |
|---|---|---|
| Control heights from one scale (R-99) | `scripts/control-size-policy.mjs` → `pnpm lint:ui` | check |
| Badge rungs from one ladder | `scripts/badge-size-policy.test.mjs` | check, not wired into `pnpm check` yet |
| Durations from the motion tokens (R-103) | `scripts/motion-policy.mjs` → `pnpm lint:ui` | check |
| No `transition-all` (R-37) | `scripts/ui-policy.mjs` → `pnpm lint:ui` | check |
| Semantic colour tokens, no raw palette | `scripts/ui-policy.mjs` → `pnpm lint:ui` | check |
| A control does what it says | `scripts/interaction-policy.mjs` → `pnpm lint:ui` | check |
| The quiet text level clears 4.5:1 where it sits (R-104) | `scripts/contrast.test.mjs` → `pnpm test:ui-policy` | check |
| Labels, greetings, apologies, brands (C-02/C-03/C-04, R-40/R-43/R-44) | `scripts/check-copy.mjs`, `scripts/copy-policy.mjs` → `pnpm check` | check |
| Nothing holding text animates a size | — | review |
| A page change does not animate | — | review |
| Describe / instruct / report | — | review |

A rule with no check decays. R-99 exists because a 28px button and a 32px select
shipped in one toolbar — its source line names the PR page — and the two badge
modules kept two scales for as long as nothing read them. When a review-only rule
above is broken twice for the same reason, the answer is a check, not a third
reminder.

The durable form belongs in `docs/design/rules.md` as R-numbers: R-37 and R-99
already carry sections 1 and 3, and the badge ladder and the copy test are not
numbered there yet. This record is provenance, not the instruction.
