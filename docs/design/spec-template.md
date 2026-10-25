# <Feature name>

Copy this file to `docs/design/<feature>.md` before you design or build a
feature. Keep it short. Delete sections that do not apply; do not leave them
empty.

- **Status:** draft / in review / accepted (date)
- **Linear / GitHub:** MIK-xx, #nn
- **Figma:** section and frame ids (accepted frames only count once listed in
  `decisions.md`)
- **Owner thread:**

## What the user does

The job in one or two sentences, in the user's words.

## Where it lives

Which column or page, what opens it, what it replaces. Use the glossary's
words: bot list, chat, thread list.

## Layout and states

Every state the design must show: empty, loading, normal, error, offline,
dark mode, narrow window. For each one, the Figma frame or a sentence.

## Rules that apply

The `rules.md` ids this feature touches (for example R-10, R-23), and any
new rule it needs. A new rule needs Alex's decision and a `decisions.md` row.

## Components

What it is built from (`components.md`). Name any new component and why
nothing existing fits.

## Copy

Every visible string, Chinese first. No explanatory copy (R-40).

## Out of scope

What this feature does not do, so nobody adds it.

## Done when

The checks from `docs/review-checklist.md` plus anything specific to this
feature.
