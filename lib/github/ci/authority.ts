import 'server-only'
import type { Pool, PoolClient } from 'pg'

/** A membership lock must precede every app issue/observation lock. */
export async function acquireCiMembership(issueId: string, userId: string, ownerHint: string, workspace?: Pick<Pool, 'connect'>) {
  if (!ownerHint) throw new Error('CI issue authority unavailable')
  if (ownerHint === userId) return { held: false, signal: undefined, async check() {}, async close() {} }
  const source = workspace ?? (await import('@/lib/workspace-db')).workspacePool
  const client: PoolClient = await source.connect()
  let closed = false
  let failed = false
  const controller = new AbortController()
  const fail = () => { failed = true; controller.abort() }
  client.on('error', fail)
  client.on('end', fail)
  const close = async () => {
    if (closed) return
    closed = true
    if (!failed) try { await client.query('ROLLBACK') } catch { failed = true }
    client.removeListener('error', fail)
    client.removeListener('end', fail)
    client.release(failed ? new Error('CI workspace authority lost') : undefined)
  }
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const { rowCount } = await client.query(`SELECT 1 FROM mikka_team_issues t
      JOIN mikka_teams team ON team.id=t."teamId" AND team."workspaceId"=t."workspaceId"
      JOIN mikka_workspace_members m ON m."workspaceId"=team."workspaceId"
      WHERE t."issueId"=$1 AND m."userId"=$2 AND m.status='active' FOR SHARE OF t,team,m`, [issueId, userId])
    if (!rowCount || failed) throw new Error('CI issue authority unavailable')
    return { held: true, signal: controller.signal, async check() { if (failed || closed) throw new Error('CI workspace authority lost'); await client.query('SELECT 1'); if (failed) throw new Error('CI workspace authority lost') }, close }
  } catch (error) { await close(); throw error }
}

/** The workspace lease authorizes only the same still-shared issue. */
export function ciIssueAuthorized(issue: { userId: string; scope: string; scopeVersion: number; content: unknown } | undefined, userId: string, scopeVersion: number, membershipHeld: boolean, deleted: (content: unknown) => boolean) {
  return Boolean(issue && issue.scopeVersion === scopeVersion && !deleted(issue.content) && (issue.userId === userId || (membershipHeld && issue.scope === 'workspace')))
}
