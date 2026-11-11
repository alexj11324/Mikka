/**
 * Only the host's source-bound, already committed CI webhook event may bypass
 * paid semantic triage. This grants a result turn, never GitHub permissions.
 * The selected run is also checked by the normal visibleRuns reader.
 */
export type CiSuiteOutboxObservation = {
  kind: string
  runId: string | null
  botId: string | null
  dedupeKey: string
  payload: Record<string, unknown>
  observedRun?: { id: string; status: string; finishedAt: Date | string | null } | null
}

export function verifiedCiSuiteTransport(event: CiSuiteOutboxObservation): boolean {
  if (event.kind !== 'run_report' || !event.runId || !event.botId
    || event.observedRun?.id !== event.runId || !event.observedRun.finishedAt) return false
  const { source, repository, pullUrl, suiteHeadSha, suiteId, conclusionHint } = event.payload
  if (source !== 'github_ci_suite' || typeof repository !== 'string'
    || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[\w.-]{1,100}$/i.test(repository)
    || typeof pullUrl !== 'string' || typeof suiteHeadSha !== 'string'
    || !/^[a-f0-9]{40}$/i.test(suiteHeadSha) || typeof suiteId !== 'number'
    || !Number.isSafeInteger(suiteId) || suiteId <= 0
    || typeof conclusionHint !== 'string' || !/^[a-z_]{1,40}$/.test(conclusionHint)) return false
  const repo = repository.toLowerCase()
  const prefix = `https://github.com/${repo}/pull/`
  if (!pullUrl.toLowerCase().startsWith(prefix)
    || !/^[1-9]\d*$/.test(pullUrl.slice(prefix.length))) return false
  return event.dedupeKey === `github_ci_suite:${event.runId}:${repo}:${suiteHeadSha.toLowerCase()}:${suiteId}:${conclusionHint}`
}
