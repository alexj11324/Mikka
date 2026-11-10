'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Field, FieldGroup } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PROFILE_COLORS, PROFILE_GLYPHS, type ProfileColor, type ProfileGlyph, type ProfileMarkValue } from '@/lib/factory/agent-profile-mark'
import { HarnessMark, harnessName } from './entity-labels'

/*
 * An Agent Profile's mark (Alex, 2026-11-10): a small dotted glyph, like the
 * agents in affectUI's Live Session, that says who does a stretch of work. The
 * Agent's brand mark (HarnessMark) says what runs it and sits beside it, smaller.
 * Shape tells Profiles apart; the colour only assists and is a token.
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
const DOTS: Record<ProfileGlyph, [number, number][]> = Object.fromEntries(PROFILE_GLYPHS.map(glyph =>
  [glyph, GLYPHS[glyph].flatMap((row, y) => [...row].flatMap((cell, x) => cell === '#' ? [[x * 2 + 1, y * 2 + 1] as [number, number]] : []))])) as Record<ProfileGlyph, [number, number][]>

/** The glyph alone: 16px in rows and labels, `lg` (20px) in the editor. Decorative unless `label` names it. */
export function ProfileMark({ icon, color, label, size = 'md' }: ProfileMarkValue & { label?: string; size?: 'md' | 'lg' }) {
  // Callers resolve the mark (resolveProfileMark); an id this build does not know still draws something neutral.
  return <svg viewBox="0 0 10 10" fill="currentColor" className={cn('shrink-0', size === 'lg' ? 'size-5' : 'size-4',
    color === 'ink' && 'text-foreground', color === 'teal' && 'text-chart-2', color === 'pink' && 'text-avatar-2',
    !['ink', 'teal', 'pink'].includes(color) && 'text-muted-foreground')}
    {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
    {(DOTS[icon] ?? DOTS.square).map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={0.82} />)}
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
          <span aria-hidden="true" className={cn('size-6 rounded-full', id === 'ink' && 'bg-foreground', id === 'graphite' && 'bg-muted-foreground', id === 'teal' && 'bg-chart-2', id === 'pink' && 'bg-avatar-2', id === 'ink' && 'ring-1 ring-foreground/15 ring-inset',
            value.color === id && 'outline-2 outline-offset-2 outline-muted-foreground')} />
        </ToggleGroupItem>)}
      </ToggleGroup>
    </Field>
  </FieldGroup>
}
