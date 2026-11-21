import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { WorkspaceError } from '@/lib/workspace-access'

export const auditDatabases = () => ({ main: pool, workspace: workspacePool })

/** Both transactions belong to the caller once both clients are available. */
export async function connectAuditDatabases(database: { main: Pool; workspace: Pool }) {
  const ws = await database.workspace.connect()
  try {
    const app = await database.main.connect()
    return { ws, app }
  } catch (error) {
    ws.release()
    throw error
  }
}

export async function requireAuditAdmin(tx: PoolClient, actorId: string, workspaceId: string) {
  const row = (await tx.query<{ name: string }>(`SELECT m.name FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id
    WHERE w.id=$1 AND m."userId"=$2 AND m.status='active' AND m.role='admin' FOR SHARE OF w,m`, [workspaceId, actorId])).rows[0]
  if (!row) throw new WorkspaceError('workspaceAccessDenied')
  return row
}
