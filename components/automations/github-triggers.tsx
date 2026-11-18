'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { GitHubPullAuthors } from './github-pull-authors'
import { GITHUB_TRIGGER_EVENTS, supportsPullAuthors, type GitHubTriggerEvent } from '@/lib/schedules/contract'
import type { GitHubTriggerDraft } from './automation-draft'

const repositoryName = (key: string) => key.replace(/^v2\/github\.com\//, '')

/**
 * 满足任一条件就运行's GitHub rows: an event on one of the workspace's repositories, narrowed by branch and labels,
 * and an optional one-sentence condition checked before the run (decision 2026-11-15-1704).
 */
export function GitHubTriggers({ workspaceId, userId, value, onChange, repositories, disabled }: { workspaceId: string | null; userId: string; value: GitHubTriggerDraft[]; onChange: (next: GitHubTriggerDraft[]) => void; repositories: string[]; disabled?: boolean }) {
  const t = useTranslations('Automations.editor.github')
  const tEvent = useTranslations('Automations.githubEvent')
  const update = (index: number, patch: Partial<GitHubTriggerDraft>) => onChange(value.map((item, at) => at === index ? { ...item, ...patch } : item))
  const add = () => onChange([...value, { event: 'pull_request_opened', repositories: repositories[0] ? [repositories[0]] : [], branches: '', labels: '', runWhen: '' }])
  return <div className="flex flex-col gap-3 px-5 pb-4">
    {value.map((trigger, index) => {
      const choices = trigger.repositories.length === 1 && !repositories.includes(trigger.repositories[0]!) ? [trigger.repositories[0]!, ...repositories] : repositories
      return <div key={index} role="group" aria-label={t('item', { number: index + 1 })} className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label={t('event')} value={trigger.event} disabled={disabled} onChange={event => {
            const next = event.target.value as GitHubTriggerEvent
            update(index, { event: next, ...(supportsPullAuthors(next) ? {} : { pullAuthors: '' }) })
          }}>
            {GITHUB_TRIGGER_EVENTS.map(event => <NativeSelectOption key={event} value={event}>{tEvent(event)}</NativeSelectOption>)}
          </NativeSelect>
          {trigger.repositories.length > 1
            ? <span className="text-sm text-muted-foreground">{trigger.repositories.map(repositoryName).join(', ')}</span>
            : <NativeSelect aria-label={t('repository')} value={trigger.repositories[0] ?? ''} disabled={disabled} onChange={event => update(index, { repositories: event.target.value ? [event.target.value] : [] })}>
              <NativeSelectOption value="" disabled>{t('repository')}</NativeSelectOption>
              {choices.map(key => <NativeSelectOption key={key} value={key}>{repositoryName(key)}</NativeSelectOption>)}
            </NativeSelect>}
          <Button size="icon-sm" variant="ghost" className="ms-auto" aria-label={t('remove')} disabled={disabled} onClick={() => onChange(value.filter((_, at) => at !== index))}><X /></Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label={t('branches')} placeholder={t('branches')} value={trigger.branches} maxLength={1000} disabled={disabled} onChange={event => update(index, { branches: event.target.value })} />
          <Input aria-label={t('labels')} placeholder={t('labels')} value={trigger.labels} maxLength={1000} disabled={disabled} onChange={event => update(index, { labels: event.target.value })} />
        </div>
        {supportsPullAuthors(trigger.event) && <GitHubPullAuthors key={`${workspaceId}/${userId}/${trigger.repositories.join(',')}`} workspaceId={workspaceId} userId={userId}
          repository={trigger.repositories.length === 1 ? trigger.repositories[0] : undefined} disabled={disabled} value={trigger.pullAuthors ?? ''} onChange={pullAuthors => update(index, { pullAuthors })} />}
        <Input aria-label={t('runWhen')} placeholder={t('runWhenPlaceholder')} value={trigger.runWhen} maxLength={500} disabled={disabled} onChange={event => update(index, { runWhen: event.target.value })} />
      </div>
    })}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={disabled || !repositories.length || value.length >= 20} onClick={add}><Plus data-icon="inline-start" />{t('add')}</Button>
      {!repositories.length && <span className="text-sm text-muted-foreground">{t('noRepositories')}</span>}
    </div>
  </div>
}
