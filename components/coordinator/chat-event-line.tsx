'use client'

import { useTranslations } from 'next-intl'
import { AgentCitationsContext, CitationChip, type AgentCitations } from '@/components/workspace/agent-citations'
import type { EventLine } from '@/lib/coordinator/event-line'

const RUN_ENDED = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const ACTIONS = new Set(['done', 'failed', 'declined'])
const SCHEDULE_ENDED = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])

/**
 * A runtime event in the chat, in the person's language (review C1): the thread or task it is about as a chip
 * (R-15), then what happened. The text the model got (English, ids, instructions) is never shown.
 */
export function ChatEventLine({ line, citations }: { line: EventLine; citations: AgentCitations }) {
  const t = useTranslations('Coordinator.events')
  const tIssue = useTranslations('Issue')
  const run = line.runId && citations.sources[line.runId]?.kind === 'run' ? line.runId : null
  const issue = line.issueId && citations.sources[line.issueId]?.kind === 'issue' ? line.issueId : null
  // Without a run id the report came from an Agent outside a thread (a peer message); with one it names the thread.
  const thread = run ? <CitationChip id={run} kind="run" /> : line.runId ? t('aThread') : t('anAgent')
  const schedule = line.title ? t('schedule', { title: line.title }) : t('aSchedule')
  const task = issue ? <CitationChip id={issue} kind="issue" /> : line.title ? t('quoted', { title: line.title }) : t('aTask')
  const issueStatus = line.status && tIssue.has(`status.${line.status}` as never) ? tIssue(`status.${line.status}` as never) : null
  const [subject, what] = line.kind === 'runFinished' ? [thread, line.status && RUN_ENDED.has(line.status) ? t(`runEnded.${line.status as 'succeeded'}`) : t('runEnded.other')]
    : line.kind === 'issueStatus' ? [task, issueStatus ? t('issueMoved', { status: issueStatus }) : t('issueChanged')]
    : line.kind === 'issueSnapshot' ? [task, issueStatus ? t('issueSnapshot', { status: issueStatus }) : t('issueChanged')]
    : line.kind === 'scheduleRan' ? [schedule, line.status && SCHEDULE_ENDED.has(line.status) ? t(`scheduleEnded.${line.status as 'succeeded'}`) : t('scheduleEnded.other')]
    : line.kind === 'scheduleDue' ? [schedule, t('scheduleDue')]
    : line.kind === 'artifact' ? [null, line.title ? t('artifactTitled', { title: line.title }) : t('artifact')]
    : line.kind === 'action' ? [null, line.status && ACTIONS.has(line.status) ? t(`action.${line.status as 'done'}`) : t('action.other')]
    : line.kind === 'other' ? [null, t('other')]
    : [thread, t(line.kind)]
  return <AgentCitationsContext value={citations}>
    <p data-event-line={line.kind} className="mx-auto flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-xs text-muted-foreground wrap-break-word">
      {subject && (typeof subject === 'string' ? <span>{subject}</span> : subject)}<span>{what}</span>
    </p>
  </AgentCitationsContext>
}
