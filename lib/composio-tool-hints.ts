/**
 * The default for a write that has no person or admin setting (decision
 * 2026-10-31, R-77): it runs when the connection grants it, unless the tool's
 * own Composio metadata marks it destructive. A tool without metadata is not
 * known to be safe, so it asks.
 */
export function toolApprovalDefault(tags: unknown): 'allow' | 'ask' {
  if (!Array.isArray(tags)) return 'ask'
  return tags.includes('destructiveHint') ? 'ask' : 'allow'
}
