import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { ComputerError } from '@/lib/computer/store'
import { runPolicySchema } from '@mikka/protocol/agent-policy'

/** Share the computer policy lock with ComputerStore.setPolicy so a denial
 * cannot overtake an in-flight gateway action. This is a workspace ceiling,
 * not a substitute for any action-specific MCP/auto-review decision. */
export async function resolveWorkspaceComputerPolicy(client: PoolClient, workspaceId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${workspaceId}`])
  const row = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])).rows[0]
  const permission = row?.permission ?? 'ask'
  const version = Number(row?.version ?? 0)
  if (!['allow', 'ask', 'deny'].includes(permission) || !Number.isSafeInteger(version) || version < 0) throw new ComputerError(503, 'Computer policy unavailable')
  return { permission: permission as 'allow' | 'ask' | 'deny', version }
}

export async function requireWorkspaceComputerPolicy(client: PoolClient, workspaceId: string) {
  const policy = await resolveWorkspaceComputerPolicy(client, workspaceId)
  if (policy.permission === 'deny') throw new ComputerError(403, 'Computer use denied')
  return policy.version
}

/** A server-owned run policy can only narrow the current workspace policy.
 * Missing or invalid run context never turns into an implicit allow. */
export function effectiveWebComputerPermission(workspace: 'allow' | 'ask' | 'deny', rawRunPolicy: unknown) {
  const parsed = runPolicySchema.safeParse(rawRunPolicy)
  if (!parsed.success) throw new ComputerError(503, 'Web run policy unavailable')
  const policy = parsed.data
  const computerUse = (policy.permissions as Record<string, unknown>).computer_use
  if (policy.readOnly || workspace === 'deny' || computerUse === 'deny') return 'deny' as const
  if (workspace === 'ask' || computerUse !== 'allow') return 'ask' as const
  return 'allow' as const
}

export async function withWorkspaceComputerPermission<T>(pool: Pool, workspaceId: string, action: (client: PoolClient, version: number) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const version = await requireWorkspaceComputerPolicy(client, workspaceId)
    const result = await action(client, version)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
