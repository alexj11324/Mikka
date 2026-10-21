'use client'

import { ChartNoAxesColumnIncreasing, CircleDashed, History, LockKeyhole, Users } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'

export function IssueDetailProperties({ status, priority, revision, createdAt, updatedAt, pending, onStatus, onPriority, onMembers, onHistory }: {
  status: string; priority: string; revision: number; createdAt: Date | string; updatedAt: Date | string; pending: boolean
  onStatus: (value: string) => void; onPriority: (value: string) => void; onMembers: () => void; onHistory: () => void
}) {
  const t = useTranslations('Issue')
  const statusT = useTranslations('Issue.status')
  const priorityT = useTranslations('Issue.priority')
  const format = useFormatter()
  const statusLabel = (value: string) => statusT.has(value as never) ? statusT(value as never) : value
  const priorityLabel = (value: string) => priorityT.has(value as never) ? priorityT(value as never) : value
  return <aside aria-label={t('properties')} className="flex w-full shrink-0 flex-col gap-6 px-5 py-6 lg:w-64 xl:w-72">
    <div className="flex flex-col items-start gap-3"><h2 className="px-2 text-xs font-medium text-muted-foreground">{t('properties')}</h2>
      <IssuePropertyMenu label={t('statusLabel')} value={status} options={ISSUE_STATUSES} getLabel={statusLabel} icon={CircleDashed} disabled={pending} onChange={onStatus} />
      <IssuePropertyMenu label={t('priorityLabel')} value={priority} options={ISSUE_PRIORITIES} getLabel={priorityLabel} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={onPriority} />
      <Button variant="ghost" size="sm" onClick={onMembers}><Users data-icon="inline-start" />{t('members')}</Button>
    </div>
    <div className="flex flex-col gap-4 px-2"><h2 className="text-xs font-medium text-muted-foreground">{t('access')}</h2><p className="flex items-center gap-2 text-xs"><LockKeyhole className="size-3.5 text-muted-foreground" />{t('restricted')}</p></div>
    <div className="flex flex-col items-start gap-3"><Button size="sm" variant="ghost" onClick={onHistory}><History data-icon="inline-start" />{t('history')}<span className="text-muted-foreground">v{revision}</span></Button><dl className="flex flex-col gap-3 px-2 text-xs text-muted-foreground"><div className="flex flex-wrap gap-2"><dt>{t('createdAt')}</dt><dd><time dateTime={new Date(createdAt).toISOString()}>{format.dateTime(new Date(createdAt), { year: 'numeric', month: 'short', day: 'numeric' })}</time></dd></div><div className="flex flex-wrap gap-2"><dt>{t('updatedAt')}</dt><dd><time dateTime={new Date(updatedAt).toISOString()}>{format.dateTime(new Date(updatedAt), { year: 'numeric', month: 'short', day: 'numeric' })}</time></dd></div></dl></div>
  </aside>
}
