# `--ink-3` holds 4.5:1; Figma's tertiary text stays lighter

- Date: 2026-11-05
- Source: the Coordinator's token contrast task (PR #1295, "ink-3 ≥4.5:1") and its independent review, which measured the only place `--ink-3` is text.
- Rule: the `text/tertiary` row of the Tokens table (`rules.md`, Figma ↔ code drift).
- Replaces: —

Figma's `text/tertiary` is `#a3a3a3`, 2.5:1 on white. In code `--ink-3` is
`--muted-foreground` mixed 90% into `--background` (oklch), so it reads as a
step below muted text and still holds 4.5:1 on every surface it is text on.

`--ink-3` is text in one place: the domain on each row of the source list
(`components/ui/streaming-text.tsx`), on `bg-inset` and, hovered, on `--hover`.
There it measures light 4.62 / 4.74 and dark 4.82 / 5.09. 85% was 4.26 and
4.15 in light, below 4.5.

The drift is deliberate: Figma is lighter, code wins for contrast. A frame
that draws tertiary text takes the code value.
