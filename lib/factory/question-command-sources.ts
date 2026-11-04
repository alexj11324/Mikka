/** Host-admitted command provenance, frozen with one independent check. */
export interface QuestionCommandSource {
  runId: string
  sessionId: string
  status: 'failed' | 'stopped'
  recoveryEventId: string
  candidateSha: string
  outputChunkId: string
  observedAt: string
}
export type QuestionCommandOrigin = Omit<QuestionCommandSource, 'candidateSha' | 'outputChunkId'>

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)

/** A report can cite only source chunks the host admitted for this candidate.
 * A citation does not change the reported verdict or a predecessor's status. */
export function citedQuestionCommandSources(check: unknown, criteria: readonly { evidence: string | null }[],
  candidateId: string | null, candidateSha: string | null): QuestionCommandOrigin[] {
  if (!check || typeof check !== 'object' || Array.isArray(check) || !candidateId) return []
  const bound = check as Record<string, unknown>
  if (bound.candidateId !== candidateId || !sha(bound.sha) || (candidateSha !== null && bound.sha !== candidateSha) ||
    !Array.isArray(bound.questionCommandSources) || bound.questionCommandSources.length > 32) return []
  const cited = new Set(criteria.flatMap(criterion => [...(criterion.evidence ?? '').matchAll(/\brun-chunk:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map(match => match[1].toLowerCase())))
  const origins = new Map<string, QuestionCommandOrigin>()
  for (const value of bound.questionCommandSources) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const source = value as Record<string, unknown>
    if (source.candidateSha !== bound.sha || !uuid(source.runId) || !uuid(source.outputChunkId) || !uuid(source.recoveryEventId) ||
      typeof source.sessionId !== 'string' || !source.sessionId || source.sessionId.length > 500 ||
      !['failed', 'stopped'].includes(String(source.status)) || typeof source.observedAt !== 'string' || !Number.isFinite(Date.parse(source.observedAt)) ||
      !cited.has(source.outputChunkId.toLowerCase())) continue
    const key = source.runId + ':' + source.recoveryEventId
    const origin: QuestionCommandOrigin = { runId: source.runId, sessionId: source.sessionId, status: source.status as 'failed' | 'stopped',
      recoveryEventId: source.recoveryEventId, observedAt: new Date(source.observedAt).toISOString() }
    const prior = origins.get(key)
    if (!prior || origin.observedAt > prior.observedAt) origins.set(key, origin)
  }
  return [...origins.values()]
}
