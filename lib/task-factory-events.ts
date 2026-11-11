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
