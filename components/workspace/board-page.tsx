'use client'

import { useEffect, useId, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import { listAgents } from '@/app/actions/agents'
import { CoordinatorChat } from '@/components/coordinator/coordinator-chat'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IssueBoard } from './issue-board'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

const MINE_KEY = 'mikka:board-only-mine'
const SIDEBAR_KEY = 'mikka:board-coordinator-open'

function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(fallback)
  useEffect(() => {
    try { const stored = window.localStorage.getItem(key); if (stored !== null) setValue(stored === '1') } catch { /* storage unavailable */ }
  }, [key])
  function update(next: boolean) {
    setValue(next)
    try { window.localStorage.setItem(key, next ? '1' : '0') } catch { /* storage unavailable */ }
  }
  return [value, update] as const
}

/**
 * The board as its own page (MIK-24, Figma 57:2 / 57:94): one 只看我的 switch,
 * four columns of title-and-agent cards, and the Coordinator conversation in a
 * 360px sidebar that folds into a pill (MIK-45).
 */
export function BoardPage({ issues, userId, onOpen, onUpdated, onBusyChange }: {
  issues: Issue[]
  userId: string
  onOpen: (id: string) => boolean | void
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('Shell.board')
  const tNav = useTranslations('Nav')
  const switchId = useId()
  const [onlyMine, setOnlyMine] = useStoredFlag(MINE_KEY, true)
  const [sidebar, setSidebar] = useStoredFlag(SIDEBAR_KEY, true)
  const { data: agents } = useSWR('agents', () => listAgents(), { revalidateOnFocus: false })
  const myAgents = new Set((agents ?? []).map(agent => agent.id))
  // Mine: assigned to me, created by me, or held by one of my agents.
  const shown = onlyMine ? issues.filter(issue => issue.ownerId === userId || issue.metadata.assignee?.id === userId || (issue.metadata.assignee?.kind === 'agent' && myAgents.has(issue.metadata.assignee.id))) : issues
  return <div className="flex min-h-0 flex-1">
    <section aria-labelledby={`${switchId}-title`} className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-6 pt-5 pb-3 sm:px-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <h1 id={`${switchId}-title`} className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-xs text-muted-foreground">{t('synced')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={switchId} checked={onlyMine} onCheckedChange={setOnlyMine} className="data-checked:bg-sidebar-primary" />
          <Label htmlFor={switchId} className="font-normal">{t('onlyMine')}</Label>
        </div>
      </header>
      {!sidebar && <Button variant="secondary" className="absolute top-4 right-6 h-9 gap-2 rounded-full pr-3 pl-1.5 font-semibold shadow-md" aria-expanded={false} aria-label={t('expand')} onClick={() => setSidebar(true)}>
        <LetterAvatar name="Coordinator" tone="coordinator" size="pill" />{tNav('coordinator')}<PanelRightOpen data-icon="inline-end" />
      </Button>}
      <IssueBoard issues={shown} onOpen={id => { onOpen(id) }} onUpdated={onUpdated} onBusyChange={onBusyChange} />
    </section>
    {sidebar && <aside aria-label={tNav('coordinator')} className="hidden w-90 shrink-0 flex-col border-l bg-shell-panel lg:flex">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <LetterAvatar name="Coordinator" tone="coordinator" size="pill" />
        <h2 className="flex-1 text-sm font-semibold">{tNav('coordinator')}</h2>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('collapse')} aria-expanded onClick={() => setSidebar(false)} />}><PanelRightClose data-icon="inline-start" /></TooltipTrigger><TooltipContent side="left">{t('collapse')}</TooltipContent></Tooltip>
      </div>
      <CoordinatorChat compact placeholder={t('coordinatorPlaceholder')} onOpenIssue={id => { onOpen(id) }} />
    </aside>}
  </div>
}
