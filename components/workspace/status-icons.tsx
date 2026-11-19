/*
 * The one glyph that lucide does not ship: a run under way (decision 2026-11-18-0300). It is lucide's `CircleDot`,
 * the static 进行中, whose ring turns as a broken arc while the run is live, as LobeHub swaps its static running glyph
 * for a turning ring of the same family. Under reduced motion it is `CircleDot` itself.
 */
import { forwardRef } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'

/** Drawn where a lucide icon is, so it takes the same props; lucide's own sizing props are not SVG attributes. */
export const RunningIcon = forwardRef<SVGSVGElement, LucideProps>(({ size: _size, absoluteStrokeWidth: _absolute, strokeWidth = 2, ...props }, ref) =>
  <svg ref={ref} viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="10" className="origin-center [transform-box:fill-box] motion-safe:animate-spin motion-safe:[animation-duration:1.6s] motion-safe:[stroke-dasharray:44_19]" />
    <circle cx="12" cy="12" r="1" />
  </svg>) as LucideIcon
RunningIcon.displayName = 'RunningIcon'
