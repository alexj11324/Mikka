'use client'

import { useId, useState } from 'react'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { automationSlackAuthors, automationSlackEmojis } from '@/app/actions/automations'
import { InlineLoadError } from '@/components/load-error'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SLACK_TRIGGER_EVENTS, type SlackTriggerEvent } from '@/lib/schedules/contract'
import type { SlackTriggerDraft } from './automation-draft'

type AuthorsPage = { users: { id: string; name: string }[]; nextCursor: string | null }
export type SlackChannelOption = { id: string; name: string; private: boolean }

// The examples already in the field work with every installation. Slack's emoji.list adds only custom names.
const standardReactions = ['eyes', 'white_check_mark']

function suggestions(input: string, names: string[]) {
  const last = Math.max(input.lastIndexOf(','), input.lastIndexOf('，')) + 1
  const prefix = input.slice(0, last)
  const chosen = new Set(prefix.split(/[,，]/).map(name => name.trim().replace(/^:|:$/g, '').toLowerCase()))
  return [...new Set([...standardReactions, ...names])].filter(name => !chosen.has(name))
    .map(name => prefix ? `${prefix} ${name}` : name)
}

/**
 * 满足任一条件就运行's Slack rows (decision 2026-11-15-2010): a person's message, mention or reaction in one of the
 * channels Mikka's Slack app can see in this workspace, and an optional one-sentence condition checked before the run.
 */
export function SlackTriggers({ workspaceId, userId, value, onChange, channels, installed, disabled }: { workspaceId: string | null; userId: string; value: SlackTriggerDraft[]; onChange: (next: SlackTriggerDraft[]) => void; channels: SlackChannelOption[]; installed: boolean; disabled?: boolean }) {
  const t = useTranslations('Automations.editor.slack')
  const tEvent = useTranslations('Automations.slackEvent')
  const tCommon = useTranslations('Common')
  const listId = useId()
  const [requested, setRequested] = useState(false)
  const emojis = useSWR(requested && workspaceId && installed ? ['automation-slack-emojis', workspaceId, userId] as const : null, async ([, shown]) => {
    const result = await automationSlackEmojis(shown)
    if ('error' in result && result.error) throw new Error(result.error)
    return result.emojis
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  const [editingAuthors, setEditingAuthors] = useState(false)
  const authors = useSWRInfinite((index: number, previous: AuthorsPage | null) => {
    if (!editingAuthors || !installed || !workspaceId || (index > 0 && !previous?.nextCursor)) return null
    return ['automation-slack-authors', workspaceId, userId, previous?.nextCursor ?? null] as const
  }, async ([, shown, , cursor]) => {
    const result = await automationSlackAuthors(shown, cursor ?? undefined)
    if ('error' in result && result.error) throw new Error(result.error)
    return { users: result.users, nextCursor: result.nextCursor }
  }, { revalidateFirstPage: false, revalidateOnFocus: false, shouldRetryOnError: false })
  const members = new Map((authors.error ? [] : authors.data ?? []).flatMap(page => page.users.map(user => [user.id, user.name] as const)))
  const update = (index: number, patch: Partial<SlackTriggerDraft>) => onChange(value.map((item, at) => at === index ? { ...item, ...patch } : item))
  const add = () => onChange([...value, { event: 'message', channels: channels[0] ? [channels[0].id] : [], authors: '', reactions: '', runWhen: '' }])
  const label = (id: string) => { const channel = channels.find(item => item.id === id); return channel ? `#${channel.name}` : id }
  return <div className="flex flex-col gap-3 px-5 pb-4">
    {value.map((trigger, index) => {
      const prefix = trigger.authors.slice(0, Math.max(trigger.authors.lastIndexOf(','), trigger.authors.lastIndexOf('，')) + 1)
      const selected = new Set(prefix.split(/[,，]/).map(id => id.trim()))
      return <div key={index} role="group" aria-label={t('item', { number: index + 1 })} className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
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
        <Input list={`${listId}-authors-${index}`} onFocus={() => setEditingAuthors(true)} aria-label={t('authors')} placeholder={t('authors')} value={trigger.authors} maxLength={1000} disabled={disabled} onChange={event => update(index, { authors: event.target.value })} />
        <datalist id={`${listId}-authors-${index}`}>{[...members].filter(([id]) => !selected.has(id)).map(([id, name]) => <option key={id} value={prefix ? `${prefix} ${id}` : id} label={name} />)}</datalist>
        {trigger.event === 'reaction_added' && <><Input list={`${listId}-${index}`} onFocus={() => setRequested(true)} aria-label={t('reactions')} placeholder={t('reactions')} value={trigger.reactions} maxLength={1000} disabled={disabled} onChange={event => update(index, { reactions: event.target.value })} />
          <datalist id={`${listId}-${index}`}>{suggestions(trigger.reactions, emojis.error ? [] : emojis.data ?? []).map(name => <option key={name} value={name} />)}</datalist></>}
        <Input aria-label={t('runWhen')} placeholder={t('runWhenPlaceholder')} value={trigger.runWhen} maxLength={500} disabled={disabled} onChange={event => update(index, { runWhen: event.target.value })} />
      </div>
    })}
    {authors.error ? <InlineLoadError message={t('authorsError')} retryLabel={tCommon('retry')} onRetry={() => { void authors.mutate() }} />
      : authors.data?.at(-1)?.nextCursor && <Button size="sm" variant="outline" disabled={disabled || authors.isValidating} onClick={() => { void authors.setSize(authors.size + 1) }}>{t('moreAuthors')}</Button>}
    {emojis.error && <InlineLoadError message={t('emojisError')} retryLabel={tCommon('retry')} onRetry={() => { void emojis.mutate() }} />}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={disabled || !channels.length || value.length >= 20} onClick={add}><Plus data-icon="inline-start" />{t('add')}</Button>
      {!installed && <span className="text-sm text-muted-foreground">{t('notInstalled')}</span>}
      {installed && !channels.length && <span className="text-sm text-muted-foreground">{t('noChannels')}</span>}
    </div>
  </div>
}
