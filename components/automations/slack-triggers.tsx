'use client'

import { useTranslations } from 'next-intl'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SLACK_TRIGGER_EVENTS, type SlackTriggerEvent } from '@/lib/schedules/contract'
import type { SlackTriggerDraft } from './automation-draft'

export type SlackChannelOption = { id: string; name: string; private: boolean }

/**
 * 满足任一条件就运行's Slack rows (decision 2026-11-15-2010): a person's message, mention or reaction in one of the
 * channels Mikka's Slack app can see in this workspace, and an optional one-sentence condition checked before the run.
 */
export function SlackTriggers({ value, onChange, channels, installed, disabled }: { value: SlackTriggerDraft[]; onChange: (next: SlackTriggerDraft[]) => void; channels: SlackChannelOption[]; installed: boolean; disabled?: boolean }) {
  const t = useTranslations('Automations.editor.slack')
  const tEvent = useTranslations('Automations.slackEvent')
  const update = (index: number, patch: Partial<SlackTriggerDraft>) => onChange(value.map((item, at) => at === index ? { ...item, ...patch } : item))
  const add = () => onChange([...value, { event: 'message', channels: channels[0] ? [channels[0].id] : [], reactions: '', runWhen: '' }])
  const label = (id: string) => { const channel = channels.find(item => item.id === id); return channel ? `#${channel.name}` : id }
  return <div className="flex flex-col gap-3 px-5 pb-4">
    {value.map((trigger, index) => <div key={index} role="group" aria-label={t('item', { number: index + 1 })} className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label={t('event')} value={trigger.event} disabled={disabled} onChange={event => update(index, { event: event.target.value as SlackTriggerEvent })}>
          {SLACK_TRIGGER_EVENTS.map(event => <NativeSelectOption key={event} value={event}>{tEvent(event)}</NativeSelectOption>)}
        </NativeSelect>
        {trigger.channels.length > 1
          ? <span className="text-sm text-muted-foreground">{trigger.channels.map(label).join(', ')}</span>
          : <NativeSelect aria-label={t('channel')} value={trigger.channels[0] ?? ''} disabled={disabled} onChange={event => update(index, { channels: event.target.value ? [event.target.value] : [] })}>
            <NativeSelectOption value="" disabled>{t('channel')}</NativeSelectOption>
            {trigger.channels[0] && !channels.some(channel => channel.id === trigger.channels[0]) && <NativeSelectOption value={trigger.channels[0]}>{trigger.channels[0]}</NativeSelectOption>}
            {channels.map(channel => <NativeSelectOption key={channel.id} value={channel.id}>{label(channel.id)}</NativeSelectOption>)}
          </NativeSelect>}
        <Button size="icon-sm" variant="ghost" className="ms-auto" aria-label={t('remove')} disabled={disabled} onClick={() => onChange(value.filter((_, at) => at !== index))}><X /></Button>
      </div>
      {trigger.event === 'reaction_added' && <Input aria-label={t('reactions')} placeholder={t('reactions')} value={trigger.reactions} maxLength={1000} disabled={disabled} onChange={event => update(index, { reactions: event.target.value })} />}
      <Input aria-label={t('runWhen')} placeholder={t('runWhenPlaceholder')} value={trigger.runWhen} maxLength={500} disabled={disabled} onChange={event => update(index, { runWhen: event.target.value })} />
    </div>)}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={disabled || !channels.length || value.length >= 20} onClick={add}><Plus data-icon="inline-start" />{t('add')}</Button>
      {!installed && <span className="text-sm text-muted-foreground">{t('notInstalled')}</span>}
      {installed && !channels.length && <span className="text-sm text-muted-foreground">{t('noChannels')}</span>}
    </div>
  </div>
}
