'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { cn } from '@/lib/utils'
import { Field, FieldGroup } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  PROFILE_COLORS,
  PROFILE_GLYPHS,
  type ProfileColor,
  type ProfileGlyph,
  type ProfileMarkState,
  type ProfileMarkValue,
} from '@/lib/factory/agent-profile-mark'
import { HarnessMark, harnessName } from './entity-labels'

/*
 * An Agent Profile's mark (Alex, 2026-11-10; states: Figma "Chat+右栏" section 21, #2932):
 * a small dotted glyph, like the agents in affectUI's Live Session, that says who does a
 * stretch of work. The Agent's brand mark (HarnessMark) says what runs it and sits beside
 * it, smaller. Shape tells Profiles apart; the colour only assists and is a token.
 */

/** Each glyph on a 5 × 5 dot grid, top row first. */
const GLYPHS: Record<ProfileGlyph, readonly string[]> = {
  square: ['.....', '.###.', '.###.', '.###.', '.....'],
  chevrons: ['.....', '.#.#.', '#...#', '.#.#.', '.....'],
  lens: ['###..', '#.#..', '###..', '...#.', '....#'],
  lines: ['#####', '.....', '#####', '.....', '###..'],
  check: ['.....', '....#', '...#.', '#.#..', '.#...'],
  stairs: ['#....', '###..', '..#..', '..###', '....#'],
  diamond: ['..#..', '.#.#.', '#...#', '.#.#.', '..#..'],
  arrow: ['..#..', '.###.', '#.#.#', '..#..', '..#..'],
}

type DotPoint = { cx: number; cy: number; gx: number; gy: number }

const DOTS: Record<ProfileGlyph, DotPoint[]> = Object.fromEntries(PROFILE_GLYPHS.map(glyph =>
  [glyph, GLYPHS[glyph].flatMap((row, gy) => [...row].flatMap((cell, gx) => cell === '#' ? [{ cx: gx * 2 + 1, cy: gy * 2 + 1, gx, gy }] : []))])) as Record<ProfileGlyph, DotPoint[]>

/** Chromatic palette (#2878 / Figma 1346:5024) plus legacy ink/graphite tokens so transitions stay lossless. */
export type ProfileMarkColorInput = ProfileColor | 'blue' | 'teal' | 'emerald' | 'violet' | 'pink'

/** Text token for the state label paired beside a ProfileMark (`needs-you` and `failed` must never rely on colour alone). */
export const PROFILE_MARK_STATE_TEXT_CLASS: Record<ProfileMarkState, string> = {
  working: 'text-muted-foreground',
  idle: 'text-muted-foreground',
  'needs-you': 'text-warning',
  failed: 'text-destructive',
}

/** Diagonal sweep cycle for `working` state (1200ms loop, ease-in-out). */
export const PROFILE_MARK_SWEEP_DURATION_MS = 1200
/** Whole-icon breathing cycle under `prefers-reduced-motion: reduce` (2000ms loop). */
export const PROFILE_MARK_REDUCED_DURATION_MS = 2000
/** Maximum grid diagonal sum `gx + gy` on the 5 × 5 dot matrix (`0..4` + `0..4`). */
export const PROFILE_MARK_MAX_DIAG = 8

/** Negative phase offset so the bright band sweeps smoothly along `x + y` from top-left to bottom-right. */
export function profileMarkDotDelayMs(gx: number, gy: number): number {
  const diag = Math.max(0, Math.min(PROFILE_MARK_MAX_DIAG, gx + gy))
  if (diag === 0 || diag === PROFILE_MARK_MAX_DIAG) return 0
  return -Math.round(((PROFILE_MARK_MAX_DIAG - diag) / PROFILE_MARK_MAX_DIAG) * PROFILE_MARK_SWEEP_DURATION_MS)
}

export type ProfileMarkProps = {
  icon: ProfileGlyph
  color: ProfileMarkColorInput
  /** Thread/agent run state: `working` sweeps diagonally, `idle` stays still, `needs-you` is warning, `failed` is destructive. */
  state?: ProfileMarkState
  label?: string
  size?: 'md' | 'lg'
}

/** The glyph alone: 16px in rows and labels, `lg` (20px) in the editor. Decorative unless `label` names it. */
export function ProfileMark({ icon, color, state = 'idle', label, size = 'md' }: ProfileMarkProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dots = DOTS[icon] ?? DOTS.square

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || state !== 'working' || typeof svg.animate !== 'function') return

    const animations: Animation[] = []
    let inView = true
    const motionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null

    const syncPlayback = () => {
      const shouldPlay = inView && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
      for (const anim of animations) {
        if (shouldPlay) anim.play()
        else anim.pause()
      }
    }

    const startAnimations = () => {
      for (const anim of animations.splice(0)) anim.cancel()
      const reduced = motionQuery?.matches ?? false
      if (reduced) {
        animations.push(svg.animate(
          [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }],
          { duration: PROFILE_MARK_REDUCED_DURATION_MS, iterations: Infinity, easing: 'ease-in-out' },
        ))
      } else {
        const circles = svg.querySelectorAll<SVGCircleElement>('circle[data-dot-gx]')
        circles.forEach(circle => {
          if (typeof circle.animate !== 'function') return
          const gx = Number(circle.dataset.dotGx ?? 0)
          const gy = Number(circle.dataset.dotGy ?? 0)
          animations.push(circle.animate(
            [
              { opacity: 1, offset: 0 },
              { opacity: 0.6, offset: 0.33 },
              { opacity: 0.4, offset: 0.66 },
              { opacity: 1, offset: 1 },
            ],
            {
              duration: PROFILE_MARK_SWEEP_DURATION_MS,
              iterations: Infinity,
              easing: 'ease-in-out',
              delay: profileMarkDotDelayMs(gx, gy),
            },
          ))
        })
      }
      syncPlayback()
    }

    startAnimations()

    let observer: IntersectionObserver | null = null
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => {
        const entry = entries[entries.length - 1]
        if (!entry) return
        inView = entry.isIntersecting
        syncPlayback()
      })
      observer.observe(svg)
    }

    const onVisibilityChange = () => syncPlayback()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

    const onMotionChange = () => startAnimations()
    motionQuery?.addEventListener?.('change', onMotionChange)

    return () => {
      observer?.disconnect()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
      motionQuery?.removeEventListener?.('change', onMotionChange)
      for (const anim of animations.splice(0)) anim.cancel()
    }
  }, [state, icon])

  // Callers resolve the mark (resolveProfileMark); an id this build does not know still draws something neutral.
  const useOwnColor = state === 'working' || state === 'idle'
  return <svg
    ref={svgRef}
    viewBox="0 0 10 10"
    fill="currentColor"
    data-profile-mark-state={state}
    data-profile-mark-icon={icon}
    data-profile-mark-color={color}
    className={cn(
      'shrink-0',
      size === 'lg' ? 'size-5' : 'size-4',
      state === 'needs-you' && 'text-warning',
      state === 'failed' && 'text-destructive',
      useOwnColor && color === 'blue' && 'text-avatar-1',
      useOwnColor && color === 'teal' && 'text-chart-2',
      useOwnColor && color === 'emerald' && 'text-avatar-3',
      useOwnColor && color === 'violet' && 'text-avatar-4',
      useOwnColor && color === 'pink' && 'text-avatar-2',
      useOwnColor && !['blue', 'teal', 'emerald', 'violet', 'pink'].includes(color) && 'text-muted-foreground',
    )}
    {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
  >
    {dots.map(({ cx, cy, gx, gy }) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={0.82} data-dot-gx={gx} data-dot-gy={gy} />)}
  </svg>
}

/** The Agent's brand mark at the secondary size, beside a ProfileMark; named for screen readers. */
export function ProfileAgentMark({ harness }: { harness: string }) {
  return <span title={harnessName(harness)} className="inline-flex shrink-0 opacity-80 [&_svg]:size-3"><HarnessMark harness={harness} /></span>
}

/** Glyph and colour for a Profile, drawn like the Bot look picker (BotLookPicker): a grid of shapes, then a row of colours. */
export function ProfileMarkPicker({ value, disabled, onChange }: { value: ProfileMarkValue; disabled?: boolean; onChange: (patch: Partial<ProfileMarkValue>) => void }) {
  const t = useTranslations('Settings.agentProfiles.mark')
  return <FieldGroup className="gap-3">
    <Field>
      <ToggleGroup aria-label={t('icon')} spacing={2} className="grid w-full grid-cols-[repeat(4,auto)] justify-between gap-y-2 sm:grid-cols-[repeat(8,auto)]" value={[value.icon]} disabled={disabled}
        onValueChange={values => { const next = values[0] as ProfileGlyph | undefined; if (next) onChange({ icon: next }) }}>
        {PROFILE_GLYPHS.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`icons.${id}`)} className="size-10 min-w-0 rounded-xl p-0 data-pressed:bg-control">
          <ProfileMark icon={id} color={value.color} size="lg" />
        </ToggleGroupItem>)}
      </ToggleGroup>
    </Field>
    <Field>
      <ToggleGroup aria-label={t('color')} spacing={2} className="flex w-full gap-2" value={[value.color]} disabled={disabled}
        onValueChange={values => { const next = values[0] as ProfileColor | undefined; if (next) onChange({ color: next }) }}>
        {PROFILE_COLORS.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`colors.${id}`)} className="size-8 min-w-0 rounded-full p-0 data-pressed:bg-transparent">
          <span aria-hidden="true" className={cn('size-6 rounded-full', id === 'blue' && 'bg-avatar-1', id === 'teal' && 'bg-chart-2', id === 'emerald' && 'bg-avatar-3', id === 'violet' && 'bg-avatar-4', id === 'pink' && 'bg-avatar-2',
            value.color === id && 'outline-2 outline-offset-2 outline-muted-foreground')} />
        </ToggleGroupItem>)}
      </ToggleGroup>
    </Field>
  </FieldGroup>
}
