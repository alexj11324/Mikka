/** Task creation and edits ship on (Alex, 2026-10-31: every workspace feature
 * is on by default); deploys migrate `issue_tool_calls` themselves. An explicit
 * value other than `1` remains the incident kill switch. Per-task access and
 * frozen execution grants are still checked by the tools themselves. */
export function issueMutationsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MIKKA_ISSUE_TOOLS_ENABLED === undefined || env.MIKKA_ISSUE_TOOLS_ENABLED === '1'
}
