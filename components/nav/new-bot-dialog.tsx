'use client'
import { isBotListKey } from '@/lib/live/list-read'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { createBot, type BotView } from '@/app/actions/bots'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useActionError } from '@/lib/use-action-error'
import { BotAvatar, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from './bot-avatar'
import { BotLookPicker } from './bot-look-picker'
import { useOpenerFocus } from '@/hooks/use-focus-return'
import * as newBotSlot from '@ui-slot/new-bot'

const NAME_LENGTH = 60

/**
 * 新建 Bot (Figma 195:3226, Grok's avatar editor): a big live preview, the
 * name, 16 shapes and 12 colours. Bots run on Mikka's own
 * harness, so there is nothing else to choose; what a bot does is shaped in
 * its chat. The new bot joins the bot list and its chat opens. A UI layer's new-bot slot draws the window instead
 * (docs/ui-overlay.md); the state and createBot stay here.
 */
export function NewBotDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (bot: BotView) => void }) {
  const t = useTranslations('Shell.newBot')
  const tCommon = useTranslations('Common')
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const [name, setName] = useState('')
  const [color, setColor] = useState<BotColor>(DEFAULT_BOT_COLOR)
  const [shape, setShape] = useState<BotShape>(DEFAULT_BOT_SHAPE)
  const [saving, setSaving] = useState(false)
  // Closing returns focus to 新建 Bot; a created bot's chat takes it instead (its composer).
  const openerFocus = useOpenerFocus(open)
  const created = useRef(false)
  useEffect(() => { if (open) created.current = false; else { setName(''); setColor(DEFAULT_BOT_COLOR); setShape(DEFAULT_BOT_SHAPE) } }, [open])

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const bot = await createBot({ name: trimmed, color, shape })
      await mutate(isBotListKey)
      created.current = true
      onCreated(bot)
    } catch (error) {
      // Server actions keep the failure code as the message (botDuplicateName…).
      toast.error(actionError(error instanceof Error ? error.message : null))
    } finally {
      setSaving(false)
    }
  }

  const NewBot = newBotSlot.NewBot ?? null
  if (NewBot) return open ? <NewBot onClose={() => onOpenChange(false)} name={name} onName={setName} maxLength={NAME_LENGTH} color={color} shape={shape}
    onColor={setColor} onShape={setShape} saving={saving} onSubmit={() => { void submit() }} /> : null

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-4 p-0 shadow-2xl sm:max-w-130" closeLabel={tCommon('close')} finalFocus={() => !created.current && openerFocus()}>
      <DialogHeader className="px-5 pt-4">
        <DialogTitle className="text-base">{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      </DialogHeader>
      <form id="new-bot" className="flex flex-col gap-5 px-5" onSubmit={event => { event.preventDefault(); void submit() }}>
        {/* One live blob: picking a shape or colour morphs it. */}
        <div className="flex h-48 items-center justify-center rounded-2xl bg-muted"><BotAvatar color={color} shape={shape} size="hero" /></div>
        <FieldGroup className="gap-5">
          <Field>
            <Input id="new-bot-name" aria-label={t('name')} autoFocus value={name} maxLength={NAME_LENGTH} disabled={saving} placeholder={t('namePlaceholder')}
              className="h-11 rounded-xl border-transparent bg-muted text-center focus-visible:border-transparent focus-visible:ring-0" onChange={event => setName(event.target.value)} />
          </Field>
        </FieldGroup>
        <BotLookPicker color={color} shape={shape} disabled={saving} onColor={setColor} onShape={setShape} />
      </form>
      <DialogFooter className="m-0 rounded-b-2xl bg-transparent px-4 pt-1 pb-4">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>{tCommon('cancel')}</Button>
        <Button type="submit" form="new-bot" disabled={!name.trim() || saving}>{saving ? t('creating') : t('create')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
