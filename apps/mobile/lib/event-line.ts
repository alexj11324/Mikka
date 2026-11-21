import { runName, type CitationSource, type EventLine } from './types'
import { mobileMessages } from './messages'

const M = mobileMessages.MobileCore
const STATUS = mobileMessages.Issue.status
const EVENT = M.event

const RUN_ENDED: Record<string, string> = { succeeded: EVENT.runSucceeded, failed: EVENT.runFailed, stopped: EVENT.runStopped, cancelled: EVENT.runCancelled }
const SCHEDULE_ENDED: Record<string, string> = { succeeded: EVENT.scheduleRan, failed: EVENT.scheduleFailed, skipped: EVENT.scheduleSkipped, cancelled: EVENT.runCancelled }
const ISSUE_STATUS: Record<string, string> = STATUS
const ACTION: Record<string, string> = { done: EVENT.actionDone, failed: EVENT.actionFailed, declined: EVENT.actionDeclined }
const WHAT: Partial<Record<EventLine['kind'], string>> = {
  runRetried: EVENT.runRetried, runSwitched: EVENT.runSwitched, runPaused: EVENT.runPaused,
  runWaitingDevice: EVENT.runWaitingDevice, runDeviceBack: EVENT.runDeviceBack, runReport: EVENT.runReport, runQuestion: EVENT.runQuestion, runBlocked: EVENT.runBlocked,
}

/**
 * An event line, as the web draws it (review C1): the thread or task by name, then what happened. The text the
 * model got (English, ids, instructions) is never shown. A server too old to send `line` gets a plain line.
 */
export function eventText(line: EventLine | undefined, sources: Record<string, CitationSource>): string {
  if (!line) return EVENT.newEvent
  const run = line.runId ? sources[line.runId] : undefined
  // The thread by its task's title; the task's key (ALEX-45) is an internal id (#1386).
  const thread = run?.kind === 'run' ? runName(run) : EVENT.someThread
  const issue = line.issueId ? sources[line.issueId] : undefined
  const task = issue?.kind === 'issue' ? issue.title : line.title ? fill(EVENT.quotedTitle, { title: line.title }) : EVENT.someTask
  const schedule = line.title ? fill(EVENT.scheduledTitle, { title: line.title }) : EVENT.someSchedule
  switch (line.kind) {
    case 'runFinished': return `${thread} ${(line.status && RUN_ENDED[line.status]) ?? EVENT.runEnded}`
    case 'issueStatus': return line.status && ISSUE_STATUS[line.status] ? fill(EVENT.taskNowStatus, { task, status: ISSUE_STATUS[line.status] }) : fill(EVENT.taskStatusChanged, { task })
    case 'issueSnapshot': return line.status && ISSUE_STATUS[line.status] ? fill(EVENT.taskIsStatus, { task, status: ISSUE_STATUS[line.status] }) : fill(EVENT.taskStatusChanged, { task })
    case 'scheduleRan': return `${schedule} ${(line.status && SCHEDULE_ENDED[line.status]) ?? EVENT.scheduleResult}`
    case 'scheduleDue': return fill(EVENT.scheduleDue, { schedule })
    case 'artifact': return line.title ? fill(EVENT.artifactDelivered, { title: line.title }) : EVENT.someArtifact
    case 'action': return (line.status && ACTION[line.status]) ?? EVENT.actionNewState
    case 'other': return EVENT.newEvent
    default: return `${thread} ${WHAT[line.kind] ?? ''}`.trim()
  }
}

/** A sentence template from messages/, with its {name} slots filled. */
function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
}

/**
 * A thread still waiting for the person's answer is a card, not a grey line (#1386): its name without the task's key,
 * 「在等你回答」 and 去回答. Once answered (its group has moved on) it is an ordinary event line again.
 */
export function questionCard(line: EventLine | undefined, sources: Record<string, CitationSource>): { runId: string; title: string } | null {
  if (line?.kind !== 'runQuestion' || !line.runId) return null
  const run = sources[line.runId]
  if (run?.kind !== 'run' || (run.group && run.group !== 'waiting')) return null
  return { runId: run.id, title: runName(run) }
}
