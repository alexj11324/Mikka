/**
 * A runtime event in the chat, as the line the person sees (review C1). The stored text is written for the
 * model (eventPrompt): English, with run and task ids and instructions. The chat never shows it; it draws
 * this line in the person's language, with the thread or task as a chip (R-15). Parsed from the stored text
 * so events written before this existed read the same way.
 */
export type EventLineKind =
  | 'runFinished' | 'runRetried' | 'runSwitched' | 'runPaused' | 'runWaitingDevice' | 'runDeviceBack'
  | 'issueStatus' | 'runReport' | 'runQuestion' | 'runBlocked' | 'artifact' | 'action' | 'other'

export interface EventLine {
  kind: EventLineKind
  runId: string | null
  issueId: string | null
  /** run_finished: succeeded / failed / stopped…; issue_status_changed: the new status; action_decided: done / failed / declined… */
  status: string | null
  /** A task's or an artifact's title. */
  title: string | null
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const RUN = new RegExp(`\\b[Rr]un (${UUID})\\b`)
const ISSUE = new RegExp(`\\b(?:Issue|issue|task):? (${UUID})\\b`)

const KINDS: Record<string, EventLineKind> = {
  run_finished: 'runFinished', run_retried: 'runRetried', run_credential_switched: 'runSwitched', run_quota_paused: 'runPaused',
  run_dispatch_failed: 'runWaitingDevice', run_redispatched: 'runDeviceBack', issue_done: 'issueStatus', issue_status_changed: 'issueStatus',
  run_report: 'runReport', run_question: 'runQuestion', run_blocked: 'runBlocked', artifact_submitted: 'artifact', action_decided: 'action',
}

export function eventLine(eventKind: string | null | undefined, text: string, observedState: string | null = null): EventLine {
  const first = text.split('\n')[0] ?? ''
  const kind: EventLineKind = (eventKind ? KINDS[eventKind] : undefined) ?? 'other'
  const runId = RUN.exec(first)?.[1]?.toLowerCase() ?? null
  const issueId = ISSUE.exec(text)?.[1]?.toLowerCase() ?? null
  let status: string | null = observedState
  let title: string | null = null
  if (kind === 'issueStatus') {
    const moved = /"(.*)" moved from \S+ to (\S+?)\.$/.exec(first)
    title = moved?.[1] ?? null
    status = eventKind === 'issue_done' ? 'done' : moved?.[2] ?? null
  }
  if (kind === 'runFinished' && !status) status = /ended with status (\w+)/.exec(first)?.[1] ?? null
  if (kind === 'artifact') title = /"(.*)", version \d+/.exec(first)?.[1] ?? null
  if (kind === 'action' && !status) status = /approved .* and it is done/.test(first) ? 'done' : / but it failed/.test(first) ? 'failed' : /declined/.test(first) ? 'declined' : null
  return { kind, runId, issueId, status, title }
}
