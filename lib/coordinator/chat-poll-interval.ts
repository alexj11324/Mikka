/**
 * How often the chat re-reads: every 30 s when quiet, every 3 s while a turn
 * runs, and every 15 s while that turn's reply streams (the stream revalidates
 * on each commit; the poll only catches a dropped stream).
 */
export function chatPollInterval(latest: { working?: boolean; streamRunId?: string } | undefined) {
  if (!latest?.working) return 30_000
  return latest.streamRunId ? 15_000 : 3_000
}
