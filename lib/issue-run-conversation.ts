/** View helpers for the existing durable run chunk stream; no new session model. */
export function runIsActive(status: string) {
  return ['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(status)
}

export function runListRefreshInterval(runs: readonly { status: string }[] | undefined) {
  return runs?.some(run => runIsActive(run.status)) ? 5000 : 0
}

export function runStatusKey(status: string) {
  switch (status) {
    case 'queued': case 'preparing': case 'running': case 'waiting_input': case 'finishing':
    case 'succeeded': case 'stopped': case 'failed': case 'cancelled': return status
    default: return null
  }
}

export function runDiscussionId(runId: string) { return `discussion-run-${runId}` }
export function isRunDiscussion(id: string) { return id.startsWith('discussion-run-') }
export function runDiscussionRunId(id: string) { return isRunDiscussion(id) ? id.slice('discussion-run-'.length).split(':')[0] : null }

/** One line about what a finished run did: the report's summary, else the first line of its error. */
export function runSummaryText(run: { report: unknown; error: string | null }): string | null {
  const report = run.report
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    const summary = (report as Record<string, unknown>).summary
    if (typeof summary === 'string' && summary.trim()) return summary.trim()
  }
  return run.error?.split('\n').find(line => line.trim())?.trim() ?? null
}
