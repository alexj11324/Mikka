/** One-shot post-deploy drain for #1849. Uses existing deployment credentials;
 * never accepts or prints a token, database URL, prompt, or session identifier.
 * node --conditions=react-server --import tsx scripts/ops/revoke-borrowed-hosted-subscriptions.ts [--workspace-id UUID] [--apply]
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

async function main() {
  const { values } = parseArgs({ options: { 'workspace-id': { type: 'string' }, apply: { type: 'boolean', default: false } }, allowPositionals: false })
  const workspaceId = values['workspace-id'] === undefined ? undefined : z.uuid().parse(values['workspace-id'])
  const [{ pool }, { workspacePool }, { hostedExecutionsForRevocation, stopHostedExecutions }, { recordAudit }, { drizzle }, { resumeHook }, { coordinatorStopToken }] = await Promise.all([
    import('../../lib/db'), import('../../lib/workspace-db'), import('../../lib/hosted-execution-revocation'),
    import('../../lib/audit/record'), import('drizzle-orm/node-postgres'), import('workflow/api'), import('../../lib/coordinator/stop'),
  ])
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = { workspaceId, borrowedOnly: true }
    const matches = await hostedExecutionsForRevocation(client, scope)
    if (!values.apply) {
      await client.query('ROLLBACK')
      console.log(JSON.stringify({ mode: 'inspect', coordinatorCount: matches.sessions.length, groupTurnCount: matches.groups.length }))
      return
    }
    const stopped = await stopHostedExecutions(client, scope)
    const audit = drizzle(client)
    for (const row of matches.sessions) if (row.workspaceId) await recordAudit(audit, {
      workspaceId: row.workspaceId, actor: { type: 'system', name: 'Mikka subscription isolation migration' },
      action: 'credential.revoked', target: { type: 'hosted_execution', id: row.executionId ?? row.holder },
    })
    for (const row of matches.groups) await recordAudit(audit, {
      workspaceId: row.workspaceId, actor: { type: 'system', name: 'Mikka subscription isolation migration' },
      action: 'credential.revoked', target: { type: 'group_turn', id: row.messageId },
    })
    await client.query('COMMIT')
    // Await delivery in a finite CLI process. A completed/missing hook is not
    // evidence of an active turn stopping, so report it separately for verification.
    let delivered = 0
    for (const holder of stopped.holders) try { await resumeHook(coordinatorStopToken(holder), {}); delivered++ } catch { /* ended or already signalled */ }
    console.log(JSON.stringify({ mode: 'applied', coordinatorCount: stopped.holders.length, executionCount: stopped.executionIds.length,
      groupTurnCount: stopped.groupTurnIds.length, stopSignalsDelivered: delivered, hooksAlreadyEndedOrSignalled: stopped.holders.length - delivered }))
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release(); await Promise.all([pool.end(), workspacePool.end()]) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => {
  console.error(JSON.stringify({ operation: 'revoke-borrowed-hosted-subscriptions', error: 'operation_failed' }))
  process.exitCode = 1
})
