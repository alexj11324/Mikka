'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BOT_COLORS, BOT_SHAPES } from '@/lib/bot-shapes'
import { useActionError } from '@/lib/use-action-error'
import { BotAvatar, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from './bot-avatar'
import { BotLookPicker } from './bot-look-picker'
import { useSaveBot } from './use-save-bot'

const known = <T extends string>(value: string | undefined, options: readonly T[], fallback: T) => (options as readonly string[]).includes(value ?? '') ? value as T : fallback

/**
 * The bot's big avatar in the right panel. Clicking it opens the 新建 Bot
 * shape and colour picker; each pick saves at once and the avatar morphs.
 */
export function BotLookEditor({ botId, name, color, shape }: { botId: string; name: string; color?: string; shape?: string }) {
  const t = useTranslations('Shell.panel')
  const actionError = useActionError()
  const saveBot = useSaveBot()
  const [error, setError] = useState<string | null>(null)
  const tone = known(color, BOT_COLORS, DEFAULT_BOT_COLOR)
  const form = known(shape, BOT_SHAPES, DEFAULT_BOT_SHAPE)

  async function save(patch: { color?: BotColor; shape?: BotShape }) {
    setError(null)
    try {
      await saveBot(botId, patch)
    } catch (failure) {
      setError(actionError(failure instanceof Error ? failure.message : null))
    }
  }

  return <Popover onOpenChange={open => { if (!open) setError(null) }}>
    <PopoverTrigger render={<Button variant="ghost" aria-label={t('changeAvatar', { name })} className="size-auto rounded-full p-0 hover:bg-transparent aria-expanded:bg-transparent" />}>
      <BotAvatar color={tone} shape={form} size="profile" />
    </PopoverTrigger>
    <PopoverContent aria-label={t('changeAvatar', { name })} className="w-130 max-w-[calc(100vw-2rem)] gap-3 rounded-xl p-5 shadow-2xl ring-0">
      <BotLookPicker color={tone} shape={form} onColor={next => { void save({ color: next }) }} onShape={next => { void save({ shape: next }) }} />
      {error && <p role="alert" className="text-center text-xs text-destructive">{error}</p>}
    </PopoverContent>
  </Popover>
}
