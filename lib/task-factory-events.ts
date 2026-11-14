/** Read-only receipts from the existing authorized Factory activity endpoint.
 * gate revisions, immutable submitted files and PR receipts retain their own
 * identities. A Task discussion id is never a valid write target here. */
export type TaskFactoryEvent =
  | { kind: 'factory_gate'; id: string; at: string; factoryTaskId: string; sourceId: string; revision: number
      stage: string; status: string; attemptId: string | null; runId: string | null; candidateId: string | null }
  | { kind: 'evidence'; id: string; at: string; factoryTaskId: string; sourceId: string
      evidenceKind: 'plan' | 'acceptance' | 'document' | 'image' | 'video' | 'pull_request'
      title: string | null; attemptId: string | null; runId: string; candidateId: string | null
      artifactId: string | null; version: number | null }

type Transition = { id: string; createdAt: Date | string | null; stage: string | null; status: string | null
  revision: number | null; attemptId: string | null; previousAttemptId?: string | null; receiptCandidateId?: string | null }
type Attempt = { id: string; runId: string | null; candidateId: string | null }
type Evidence = { id: string; createdAt: string | null; kind: Extract<TaskFactoryEvent, { kind: 'evidence' }>['evidenceKind']
  title: string | null; runId: string; attemptId: string | null; candidateId?: string | null; artifactId?: string; version?: number }

export type TaskFactoryGate = Extract<TaskFactoryEvent, { kind: 'factory_gate' }>
export type TaskFactoryProgress = {
  id: string
  factoryTaskId: string
  runId: string | null
  current: TaskFactoryGate
  steps: TaskFactoryGate[]
}

/** One progress row per authorized run. Older and pre-dispatch receipts can
 * lack a run; keep them with their own attempt or the unassigned task history. */
export function taskFactoryProgress(events: readonly TaskFactoryEvent[]): TaskFactoryProgress[] {
  const groups = new Map<string, TaskFactoryProgress>()
  const gates = events.filter((event): event is TaskFactoryGate => event.kind === 'factory_gate')
    .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id))
  for (const gate of gates) {
    const owner = gate.runId ? `run:${gate.runId}` : gate.attemptId ? `attempt:${gate.attemptId}` : 'unassigned'
    const id = `progress:${gate.factoryTaskId}:${owner}`
    const group = groups.get(id)
    if (group) {
      group.steps.push(gate)
      group.current = gate
    } else {
      groups.set(id, { id, factoryTaskId: gate.factoryTaskId, runId: gate.runId, current: gate, steps: [gate] })
    }
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.current.at) - Date.parse(a.current.at) || a.id.localeCompare(b.id))
}

/** Only admitted attempts and evidence enter this projection. Historical
 * receipts sometimes refer to an attempt whose content was revoked. Do not
 * expose that attempt or infer a change across the hidden boundary. */
export function taskFactoryEvents(factoryTaskId: string, transitions: readonly Transition[], visibleAttempts: readonly Attempt[], artifacts: readonly Evidence[]): TaskFactoryEvent[] {
  const admitted = new Map(visibleAttempts.map(attempt => [attempt.id, attempt]))
  const result: TaskFactoryEvent[] = []
  let prior: Transition | null = null
  for (const row of transitions) {
    if ((row.attemptId && !admitted.has(row.attemptId)) || (row.previousAttemptId && !admitted.has(row.previousAttemptId))) { prior = null; continue }
    if (!row.createdAt || !row.stage || !row.status || row.revision === null) continue
    if (prior?.attemptId === row.attemptId && prior.stage === row.stage && prior.status === row.status) continue
    const attempt = row.attemptId ? admitted.get(row.attemptId) : undefined
    result.push({ kind: 'factory_gate', id: `gate:${factoryTaskId}:${row.id}`, at: new Date(row.createdAt).toISOString(),
      factoryTaskId, sourceId: row.id, revision: row.revision, stage: row.stage, status: row.status, attemptId: row.attemptId,
      runId: attempt?.runId ?? null, candidateId: row.receiptCandidateId && row.receiptCandidateId === attempt?.candidateId ? row.receiptCandidateId : null })
    prior = row
  }
  for (const artifact of artifacts) {
    if (!artifact.createdAt || (artifact.attemptId && !admitted.has(artifact.attemptId))) continue
    result.push({ kind: 'evidence', id: `evidence:${factoryTaskId}:${artifact.id}`, at: artifact.createdAt,
      factoryTaskId, sourceId: artifact.id, evidenceKind: artifact.kind, title: artifact.title, attemptId: artifact.attemptId,
      runId: artifact.runId, candidateId: artifact.candidateId ?? (artifact.attemptId ? admitted.get(artifact.attemptId)?.candidateId : null) ?? null,
      artifactId: artifact.artifactId ?? null, version: artifact.version ?? null })
  }
  return result.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const uuidPattern = new RegExp('^' + uuid + '$')
const receiptPattern = new RegExp('^(?:' + uuid + '|pr:' + uuid + '|artifact:' + uuid + ':v[1-9][0-9]{0,9}:' + uuid + ')$')

/** A link contains only the selected Task and immutable receipt. The existing
 * Factory/Artifact readers still authenticate the account after following it. */
export function taskEvidenceHref(issueId: string, factoryTaskId: string, receiptId: string): string | null {
  if (!uuidPattern.test(issueId) || !uuidPattern.test(factoryTaskId) || !receiptPattern.test(receiptId)) return null
  return '/?' + new URLSearchParams({ issue: issueId, factoryTask: factoryTaskId, evidence: receiptId })
}

export function readTaskEvidenceTarget(params: URLSearchParams) {
  const issueId = params.get('issue'), factoryTaskId = params.get('factoryTask'), receiptId = params.get('evidence')
  if (!issueId || !factoryTaskId || !receiptId || !taskEvidenceHref(issueId, factoryTaskId, receiptId)) return null
  return { issueId, factoryTaskId, receiptId }
}

export function presentedFactoryEvents(value: unknown, factoryTaskId: string | undefined): TaskFactoryEvent[] {
  if (!factoryTaskId || !Array.isArray(value)) return []
  const textOrNull = (value: unknown) => value === null || typeof value === 'string'
  return value.filter((event): event is TaskFactoryEvent => {
    if (!event || typeof event !== 'object' || event.factoryTaskId !== factoryTaskId ||
        typeof event.sourceId !== 'string' || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
        !textOrNull(event.runId) || !textOrNull(event.attemptId) || !textOrNull(event.candidateId)) return false
    if (event.kind === 'factory_gate') return event.id === `gate:${factoryTaskId}:${event.sourceId}` &&
      Number.isSafeInteger(event.revision) && typeof event.stage === 'string' && typeof event.status === 'string'
    return event.kind === 'evidence' && event.id === `evidence:${factoryTaskId}:${event.sourceId}` &&
      ['plan', 'acceptance', 'document', 'image', 'video', 'pull_request'].includes(event.evidenceKind) &&
      typeof event.runId === 'string' && textOrNull(event.title) && textOrNull(event.artifactId) &&
      (event.version === null || (Number.isSafeInteger(event.version) && event.version > 0))
  })
}

export function taskFactoryLabel(event: TaskFactoryEvent, labels: {
  stage: Readonly<Record<string, string>>; status: Readonly<Record<string, string>>
  report: string; screenshot: string; video: string; pullRequest: string
}) {
  if (event.kind === 'factory_gate') return [labels.stage[event.stage] ?? event.stage, labels.status[event.status] ?? event.status].join(' · ')
  const fallback = event.evidenceKind === 'image' ? labels.screenshot : event.evidenceKind === 'video' ? labels.video :
    event.evidenceKind === 'pull_request' ? labels.pullRequest : labels.report
  return [event.title || fallback, event.version === null ? null : `v${event.version}`].filter(Boolean).join(' · ')
}
