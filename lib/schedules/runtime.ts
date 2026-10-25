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

export function executeScheduleCommand(actor: Actor, command: Command) {
  if (['create','resume','update'].includes(command.action) && process.env.MIKKA_RUNTIME_SWEEP_ENABLED !== '1') throw new ScheduleError('scheduleRuntimeNotEnabled', 503)
  return schedules().command(actor, command)
}
