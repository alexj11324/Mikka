import { and, eq } from 'drizzle-orm'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { scheduledAgent } from './agent'
import 'server-only'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { ScheduleStore, type WorkspaceGuard } from './store'
import { ScheduleError, type Actor, type Command } from './contract'

const guard: WorkspaceGuard = async (owner, workspace, work) => workspaceDb.transaction(async tx => {
  try { await requireWorkspace(tx, workspace, owner) }
  catch (error) { if (error instanceof WorkspaceError) throw new ScheduleError('scheduleWorkspaceAccessDenied', 403); throw error }
  return work()
})
// Request-scoped app DB and the existing workspace membership authority.
export function schedules() { return new ScheduleStore(pool, guard, undefined, scheduledAgent) }

export async function executeScheduleCommand(actor: Actor, command: Command) {
  if (['create','resume','update'].includes(command.action) && process.env.MIKKA_RUNTIME_SWEEP_ENABLED !== '1') throw new ScheduleError('scheduleRuntimeNotEnabled', 503)
  // These commands write owned PG metadata only. Their future model/connected
  // execution has its own mandatory policy/quota fence. Revocation cannot
  // prevent the owner from pausing/cancelling or inspecting a schedule.
  if(['create','resume','update'].includes(command.action)){
    const {policyStore}=await import('@/lib/policy/runtime')
    await policyStore().current(actor.ownerId,actor.workspaceId)
  }
  return schedules().command(actor, command)
}

/** Read only: ordinary chat must never create a workspace to advertise tools. */
export async function selectedScheduleWorkspace(ownerId: string, selectedId?: string) {
  const rows = await workspaceDb.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(and(eq(workspaceMembers.userId, ownerId), eq(workspaceMembers.status, 'active'))).limit(100)
  const selected = rows.find(row => row.id === selectedId)
  return selected?.id ?? (rows.length === 1 ? rows[0].id : null)
}
