/*
 * The 进行中, 评审中 and 已完成 status icons (decision 2026-11-13-1405). Their shapes are ported from Orca's
 * ConductorProgressIcon, ConductorReviewIcon and ConductorDoneIcon:
 * https://github.com/stablyai/orca at b18029ef48122b8616397e6f11e59b99ebc22f51,
 * src/renderer/src/components/sidebar/workspace-status/presentation/workspace-status-icons.tsx
 * Copyright (c) 2026 Lovecast Inc., MIT License. The permission notice is in the NOTICE file at the repository root.
 *
 * Orca fills the ring's disc with its page colour. Here the disc is left open, so the icon sits on any surface
 * (page, card, chip, tray, either theme) without knowing it; only the check cut out of the filled 已完成 disc needs a
 * surface colour, `--status-icon-surface`, which falls back to the page background.
 */
import { forwardRef } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'

/** Drawn where a lucide icon is, so it takes the same props; lucide's own sizing props are not SVG attributes. */
function statusIcon(name: string, draw: () => React.ReactNode): LucideIcon {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(({ size: _size, absoluteStrokeWidth: _absolute, strokeWidth: _strokeWidth, ...props }, ref) =>
    <svg ref={ref} viewBox="0 0 12 12" width="24" height="24" fill="none" aria-hidden="true" {...props}>{draw()}</svg>)
  Icon.displayName = name
  return Icon
}

/** 进行中: a ring with a hand at twelve. */
export const StatusProgressIcon = statusIcon('StatusProgressIcon', () => <>
  <circle cx="6" cy="6" r="4.9" stroke="currentColor" strokeWidth="1.45" />
  <path d="M6 3.75v2.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
</>)

/** 评审中: a ring around a check. */
export const StatusReviewIcon = statusIcon('StatusReviewIcon', () => <>
  <circle cx="6" cy="6" r="4.9" stroke="currentColor" strokeWidth="1.45" />
  <path d="M4.15 6.05 5.25 7.05 7.7 4.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
</>)

/** 已完成: a filled disc with the check cut out of it. */
export const StatusDoneIcon = statusIcon('StatusDoneIcon', () => <>
  <circle cx="6" cy="6" r="5.1" fill="currentColor" />
  <path d="M4 6.05 5.25 7.25 8.05 4.7" stroke="var(--status-icon-surface, var(--background))" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
</>)
