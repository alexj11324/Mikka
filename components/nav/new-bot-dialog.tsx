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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useActionError } from '@/lib/use-action-error'
import { BOT_COLORS, BOT_SHAPES, BotAvatar, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from './bot-avatar'

/**
 * 新建 Bot (Figma 195:3226): a name, a shape and a colour. Bots run on Mikka's own
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
    <DialogContent className="gap-5 rounded-2xl p-5 shadow-2xl sm:max-w-110" closeLabel={tCommon('close')}>
      <DialogHeader>
        <DialogTitle className="text-base">{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      </DialogHeader>
      <form id="new-bot" className="flex flex-col items-center gap-5" onSubmit={event => { event.preventDefault(); void submit() }}>
        {/* One live blob: picking a shape or colour morphs it. */}
        <BotAvatar color={color} shape={shape} size="preview" />
        <FieldGroup className="gap-4">
          <Field>
            <Input id="new-bot-name" aria-label={t('name')} autoFocus value={name} maxLength={60} disabled={saving} placeholder={t('namePlaceholder')}
              className="h-10 rounded-lg focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary" onChange={event => setName(event.target.value)} />
          </Field>
          <Field>
            <ToggleGroup aria-label={t('shape')} spacing={1} className="justify-between" value={[shape]} disabled={saving} onValueChange={values => { const next = values[0] as BotShape | undefined; if (next) setShape(next) }}>
              {BOT_SHAPES.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`shapes.${id}`)} className={cn('size-6.5 min-w-0 rounded-full border-2 border-transparent p-0 data-pressed:bg-transparent', shape === id && 'border-foreground')}>
                <BotAvatar color={color} shape={id} size="swatch" />
              </ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
          <Field>
            <ToggleGroup aria-label={t('color')} spacing={1} className="justify-between" value={[color]} disabled={saving} onValueChange={values => { const next = values[0] as BotColor | undefined; if (next) setColor(next) }}>
              {BOT_COLORS.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`colors.${id}`)} className={cn('size-6.5 min-w-0 rounded-full border-2 border-transparent p-0 data-pressed:bg-transparent', color === id && 'border-foreground')}>
                <BotAvatar color={id} size="swatch" />
              </ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </form>
      <DialogFooter className="-mx-5 -mb-5 rounded-b-2xl bg-transparent p-5 pt-0">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>{tCommon('cancel')}</Button>
        <Button type="submit" form="new-bot" disabled={!name.trim() || saving}>{saving ? t('creating') : t('create')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
