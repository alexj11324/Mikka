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
    <DialogContent className="gap-4 rounded-2xl p-0 shadow-2xl sm:max-w-130" closeLabel={tCommon('close')}>
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
              className="h-11 rounded-lg text-center focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary" onChange={event => setName(event.target.value)} />
          </Field>
          <Field>
            <ToggleGroup aria-label={t('shape')} spacing={2} className="grid grid-cols-4 justify-items-center sm:grid-cols-8" value={[shape]} disabled={saving} onValueChange={values => { const next = values[0] as BotShape | undefined; if (next) setShape(next) }}>
              {BOT_SHAPES.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`shapes.${id}`)} className="size-14 min-w-0 rounded-2xl border border-transparent p-0 data-pressed:border-foreground/20 data-pressed:bg-muted">
                <BotAvatar color={color} shape={id} size="cell" still />
              </ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
          <Field>
            <ToggleGroup aria-label={t('color')} spacing={2} className="grid grid-cols-6 justify-items-center gap-y-3 px-6" value={[color]} disabled={saving} onValueChange={values => { const next = values[0] as BotColor | undefined; if (next) setColor(next) }}>
              {BOT_COLORS.map(id => <ToggleGroupItem key={id} value={id} aria-label={t(`colors.${id}`)} className="size-10 min-w-0 rounded-full p-0 data-pressed:bg-transparent">
                <span aria-hidden="true" className={cn('size-7.5 rounded-full ring-1 ring-foreground/10 ring-inset', 
                  id === 'encre' && 'bg-bot-encre', id === 'brun' && 'bg-bot-brun', id === 'rouge' && 'bg-bot-rouge', id === 'orange' && 'bg-bot-orange', id === 'ambre' && 'bg-bot-ambre', id === 'vert' && 'bg-bot-vert', id === 'turquoise' && 'bg-bot-turquoise', id === 'bleu' && 'bg-bot-bleu', id === 'violet' && 'bg-bot-violet', id === 'rose' && 'bg-bot-rose', id === 'gris' && 'bg-bot-gris', id === 'creme' && 'bg-bot-creme',
                  color === id && 'outline-2 outline-offset-3 outline-foreground')} />
              </ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </form>
      <DialogFooter className="m-0 rounded-b-2xl bg-transparent px-4 pt-1 pb-4">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>{tCommon('cancel')}</Button>
        <Button type="submit" form="new-bot" disabled={!name.trim() || saving}>{saving ? t('creating') : t('create')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
