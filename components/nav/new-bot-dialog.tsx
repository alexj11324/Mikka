'use client'

import { useEffect, useState } from 'react'
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

/**
 * 新建 Bot (Figma 195:3226, Grok's avatar editor): a big live preview, the
 * name, 16 shapes and 12 colours. Bots run on Mikka's own
 * harness, so there is nothing else to choose; what a bot does is shaped in
 * its chat. The new bot joins the bot list and its chat opens.
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
  useEffect(() => { if (!open) { setName(''); setColor(DEFAULT_BOT_COLOR); setShape(DEFAULT_BOT_SHAPE) } }, [open])

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const bot = await createBot({ name: trimmed, color, shape })
      await mutate('bots')
      onCreated(bot)
    } catch (error) {
      // Server actions keep the failure code as the message (botDuplicateName…).
      toast.error(actionError(error instanceof Error ? error.message : null))
    } finally {
      setSaving(false)
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-4 p-0 shadow-2xl sm:max-w-130" closeLabel={tCommon('close')}>
      <DialogHeader className="px-5 pt-4">
        <DialogTitle className="text-base">{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      </DialogHeader>
      <form id="new-bot" className="flex flex-col gap-5 px-5" onSubmit={event => { event.preventDefault(); void submit() }}>
        {/* One live blob: picking a shape or colour morphs it. */}
        <div className="flex h-48 items-center justify-center rounded-2xl bg-muted"><BotAvatar color={color} shape={shape} size="hero" /></div>
        <FieldGroup className="gap-5">
          <Field>
            <Input id="new-bot-name" aria-label={t('name')} autoFocus value={name} maxLength={60} disabled={saving} placeholder={t('namePlaceholder')}
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
