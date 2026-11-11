import { z } from 'zod'
import { eventLine, type EventLine } from './event-line'

const lineSchema = z.object({
  kind: z.enum(['runFinished', 'runRetried', 'runSwitched', 'runPaused', 'runWaitingDevice', 'runDeviceBack', 'issueStatus', 'issueSnapshot', 'runReport', 'runQuestion', 'runBlocked', 'artifact', 'action', 'scheduleRan', 'scheduleDue', 'other']),
  runId: z.string().nullable(), issueId: z.string().nullable(), status: z.string().nullable(), title: z.string().nullable(),
})
/** Host-owned presentation, separate from the execution/model body. */
export const messageDisplaySchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('person'), text: z.string() }),
  z.object({ version: z.literal(1), kind: z.literal('welcome') }),
  z.object({ version: z.literal(1), kind: z.literal('hidden') }),
  z.object({ version: z.literal(1), kind: z.literal('event'), line: lineSchema, artifacts: z.array(z.uuid()).optional() }),
  z.object({ version: z.literal(1), kind: z.literal('reply'), text: z.string() }),
])
export type MessageDisplay = z.infer<typeof messageDisplaySchema>
const HIDDEN_EVENTS = new Set(['run_finished', 'matter_handoff', 'daily_briefing'])
const other: EventLine = { kind: 'other', runId: null, issueId: null, status: null, title: null }

export function runtimeMessageDisplay(event: { kind: string; payload: Record<string, unknown> }, projection: string): MessageDisplay {
  if (HIDDEN_EVENTS.has(event.kind)) return { version: 1, kind: 'hidden' }
  if (event.kind === 'run_report' && ['schedule_due', 'schedule_result'].includes(String(event.payload.source))) {
    const title = typeof event.payload.title === 'string' ? event.payload.title : null
    const status = event.payload.source === 'schedule_result' && typeof event.payload.status === 'string' ? event.payload.status : null
    return { version: 1, kind: 'event', line: { kind: event.payload.source === 'schedule_due' ? 'scheduleDue' : 'scheduleRan', runId: null, issueId: null, title, status } }
  }
  const artifact = event.kind === 'artifact_submitted' ? z.uuid().safeParse(event.payload.artifactId) : null
  const observed = ['run_finished','action_decided'].includes(event.kind) && typeof event.payload.status==='string' ? event.payload.status : null
  return { version: 1, kind: 'event', line: eventLine(event.kind, projection, observed), ...(artifact?.success ? { artifacts: [artifact.data] } : {}) }
}

/** Unknown/malformed host presentation never falls back to its control text. */
export function messageDisplay(message: unknown): MessageDisplay | null {
  if (!message || typeof message !== 'object') return null
  const row = message as Record<string, unknown>
  if ('mikkaDisplay' in row) {
    const parsed = messageDisplaySchema.safeParse(row.mikkaDisplay)
    return parsed.success ? parsed.data : { version: 1, kind: 'event', line: other }
  }
  const source = row.mikkaEvent
  if (!source || typeof source !== 'object') return null
  const kind = (source as { eventKind?: unknown }).eventKind
  const content = typeof row.content === 'string' ? row.content : ''
  return typeof kind === 'string' ? runtimeMessageDisplay({ kind, payload: {status:(source as {observedState?:unknown}).observedState} }, content) : { version: 1, kind: 'event', line: other }
}
