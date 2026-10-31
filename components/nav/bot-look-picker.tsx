'use client'

import { useTranslations } from 'next-intl'
import { Field, FieldGroup } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { BOT_COLORS, BOT_SHAPES, BotAvatar, type BotColor, type BotShape } from './bot-avatar'

/** A bot's 16 shapes and 12 colours (Figma 195:3226), shared by 新建 Bot, the right panel's avatar and the first-run guide. */
export function BotLookPicker({ color, shape, disabled, onColor, onShape }: { color: BotColor; shape: BotShape; disabled?: boolean; onColor: (color: BotColor) => void; onShape: (shape: BotShape) => void }) {
  const t = useTranslations('Shell.newBot')
  return <FieldGroup className="gap-5">
    {/* The picked shape gets a ring that follows its own outline, a small gap away. */}
    <svg aria-hidden="true" className="absolute size-0">
      <filter id="bot-shape-ring" x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
        {/* Blur then threshold grows the outline evenly; a morphology dilate would square off the curves. */}
        <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
        <feComponentTransfer result="gap"><feFuncA type="linear" slope="40" intercept="-3" /></feComponentTransfer>
        <feGaussianBlur in="SourceAlpha" stdDeviation="5" />
        <feComponentTransfer result="outer"><feFuncA type="linear" slope="40" intercept="-3" /></feComponentTransfer>
        <feComposite in="outer" in2="gap" operator="out" result="ring" />
        <feFlood className="[flood-color:var(--muted-foreground)]" />
        <feComposite in2="ring" operator="in" result="line" />
        <feMerge><feMergeNode in="line" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </svg>
    <Field>
      <ToggleGroup aria-label={t('shape')} spacing={2} className="grid grid-cols-4 justify-items-center sm:grid-cols-8" value={[shape]} disabled={disabled} onValueChange={values => { const next = values[0] as BotShape | undefined; if (next) onShape(next) }}>
        {BOT_SHAPES.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`shapes.${id}`)} className="size-14 min-w-0 rounded-2xl p-0 hover:bg-transparent data-pressed:bg-transparent data-pressed:[&_svg]:[filter:url(#bot-shape-ring)]">
          <BotAvatar color={color} shape={id} size="cell" still />
        </ToggleGroupItem>)}
      </ToggleGroup>
    </Field>
    <Field>
      <ToggleGroup aria-label={t('color')} spacing={2} className="grid grid-cols-6 justify-items-center gap-y-3 px-6" value={[color]} disabled={disabled} onValueChange={values => { const next = values[0] as BotColor | undefined; if (next) onColor(next) }}>
        {BOT_COLORS.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`colors.${id}`)} className="size-10 min-w-0 rounded-full p-0 data-pressed:bg-transparent">
          <span aria-hidden="true" className={cn('size-7.5 rounded-full',
            id === 'encre' && 'bg-bot-encre', id === 'brun' && 'bg-bot-brun', id === 'rouge' && 'bg-bot-rouge', id === 'orange' && 'bg-bot-orange', id === 'ambre' && 'bg-bot-ambre', id === 'vert' && 'bg-bot-vert', id === 'turquoise' && 'bg-bot-turquoise', id === 'bleu' && 'bg-bot-bleu', id === 'violet' && 'bg-bot-violet', id === 'rose' && 'bg-bot-rose', id === 'gris' && 'bg-bot-gris', id === 'creme' && 'bg-bot-creme',
            // Ink on the dark page and cream on the light one need an edge to be seen at all.
            (id === 'encre' || id === 'creme') && 'ring-1 ring-foreground/15 ring-inset',
            color === id && 'outline-2 outline-offset-3 outline-muted-foreground')} />
        </ToggleGroupItem>)}
      </ToggleGroup>
    </Field>
  </FieldGroup>
}
