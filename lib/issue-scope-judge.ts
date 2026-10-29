import 'server-only'

/** Legacy scheduled callbacks may still run after deployment. Scope is now
 * personal until an explicit user choice is recorded; context and model
 * classification must never promote it. Keep the entry point for old jobs. */
export async function judgeIssueScope(_issueId: string, _source: string): Promise<void> {
  return
}
