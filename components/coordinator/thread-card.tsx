'use client'

import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import type { RunSource } from '@/lib/coordinator/citations'
import { runIsActive } from '@/lib/issue-run-conversation'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { Button } from '@/components/ui/button'
import { ThreadStatus, harnessLabel } from '@/components/workspace/issue-threads'

/**
 * A thread the Coordinator dispatched, under its reply (R-66): the bot, the thread's
 * name and status, then one line. The coding agent shows only in that line, as a step
 * (R-62). The card follows the run in place; clicking it opens the thread conversation.
 */
export function ThreadCard({ run, onOpen }: { run: RunSource; onOpen: (thread: { issueId: string; runId: string }) => void }) {
  const t = useTranslations('IssueThreads')
  const issue = run.issue
  const line = runIsActive(run.status)
    ? run.steps ? t('steps', { harness: harnessLabel(run.harness), count: run.steps }) : t('starting')
    : run.summary
  return <Button
    variant="outline"
    className="h-auto w-full max-w-md justify-start gap-3 rounded-xl px-3.5 py-3 text-left whitespace-normal"
    aria-label={t('open', { name: run.name })}
    disabled={!issue}
    onClick={issue ? () => onOpen({ issueId: issue.id, runId: run.id }) : undefined}
  >
    <LetterAvatar name={run.agentName} size="pill" />
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{run.name}</span>
        <ThreadStatus status={run.status} />
      </span>
      <span className="truncate text-xs font-normal text-muted-foreground">{line ? `${run.agentName} · ${line}` : run.agentName}</span>
    </span>
    <ChevronRight data-icon="inline-end" className="text-muted-foreground" />
  </Button>
}
