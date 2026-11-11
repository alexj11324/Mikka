'use client'
import { isBotListKey } from '@/lib/live/list-read'

import { useEffect, useState } from 'react'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { createBot, type BotView } from '@/app/actions/bots'
import { useActionError } from '@/lib/use-action-error'
import { DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from './bot-avatar'
import { NewBot } from '@ui-slot/new-bot'

const NAME_LENGTH = 60

export function NewBotDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (bot: BotView) => void }) {
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const [name, setName] = useState('')
  const [color, setColor] = useState<BotColor>(DEFAULT_BOT_COLOR)
  const [shape, setShape] = useState<BotShape>(DEFAULT_BOT_SHAPE)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!open) { setName(''); setColor(DEFAULT_BOT_COLOR); setShape(DEFAULT_BOT_SHAPE) } }, [open])

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const bot = await createBot({ name: trimmed, color, shape })
      await mutate(isBotListKey)
      onCreated(bot)
    } catch (error) {
      // Server actions keep the failure code as the message (botDuplicateName…).
      toast.error(actionError(error instanceof Error ? error.message : null))
    } finally {
      setSaving(false)
    }
  }

  return open ? <NewBot onClose={() => onOpenChange(false)} name={name} onName={setName} maxLength={NAME_LENGTH} color={color} shape={shape}
    onColor={setColor} onShape={setShape} saving={saving} onSubmit={() => { void submit() }} /> : null
}
