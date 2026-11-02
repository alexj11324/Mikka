# Align reply retry with its failure state

- Date: 2026-11-02
- Source: Alex, reviewing a failed Claude subscription reply: 「而且重试按钮感觉有点靠下」。
- Rule: R-40; existing chat refusal layout in `components/coordinator/composer-notice.ts`.
- Replaces: —

The failed-reply title and retry action use the same vertically centered,
wrapping row as subscription and hosted-model refusal notices. The action
participates in the row's height instead of being positioned absolutely over
a title-only alert. Its retry result also participates in normal layout, so
it cannot overlap the next message or the composer at narrow widths.

Keep the notice attached to the failed turn, with the existing above-composer
fallback for failures without a message marker. Recovery behavior and labels
stay the same.
