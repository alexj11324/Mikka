import 'server-only'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { armDueTimer } from '@/lib/due-timer'
import { sendLiveInvalidations } from '@/lib/live/notify'
import { InboxStore } from './store'
import { createInboxGuard } from './workspace'

export const inboxGuard = createInboxGuard()

export async function inboxChanged(userId: string, workspaceId: string) {
  // Existing keys work with the already deployed gateway and clients. The
  // read contract lists them; no new gateway capability or poller is required.
  const member = await workspacePool.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\'', [workspaceId, userId])
  if (!member.rowCount) return
  await sendLiveInvalidations({ ownerId: userId, workspaceId }, [{ kind: 'issue_list', id: workspaceId }, { kind: 'pending_actions', id: workspaceId }])
}
export const inbox = () => new InboxStore(pool, inboxGuard, inboxChanged, () => armDueTimer('schedules'))
export const expireInboxSnoozes = () => inbox().expire()
