/**
 * badge-size.ts -- the one ladder every badge in the app is drawn on.
 *
 * A badge is a value or a thing named, not a control: it stands one rung
 * below the button beside it and must line up with every other badge on the
 * row. Two badge modules with their own `h-*`, `px-*` and `text-*` is how
 * that stopped being true (2026-11-19): `components/ui/badge` drew 20px at
 * 12px type while `components/reui/badge` drew 16, 18, 20, 22 and 24px at
 * 9.6, 11, 12, 12 and 13px, so a row mixing them had no baseline.
 *
 * The rungs are read as roles, never as lengths, and both modules import
 * this map. Add a rung here or nowhere: `scripts/badge-size-policy.test.mjs`
 * fails when either module spells a size of its own again.
 */
export const BADGE_SIZE = {
  /** Below the control scale: a caption line's count, 16px. */
  xs: "h-4 min-w-4 px-1 text-3xs leading-none gap-1",
  /** 18px, for a row of counts beside `text-2xs` (11px). */
  sm: "h-4.5 min-w-4.5 px-1.5 text-2xs leading-none gap-1",
  /** 20px, the default: the same box as a `--control-xs` row's chip. */
  md: "h-5 min-w-5 px-2 py-0.5 text-xs gap-1",
  /** 22px, a header chip beside `text-xs` (12px). */
  lg: "h-5.5 min-w-5.5 px-2 py-0.5 text-xs gap-1",
  /** 24px, a title-adjacent chip beside `text-sm` (13px). */
  xl: "h-6 min-w-6 px-2.5 py-0.5 text-sm gap-1.5",
} as const

export type BadgeSize = keyof typeof BADGE_SIZE
