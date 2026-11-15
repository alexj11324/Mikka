'use server'

import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { actingContext } from '@/lib/activity-actor'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { isActionErrorCode } from '@/lib/workspace-admin/action'
import { WorkspaceError } from '@/lib/workspace-access'
import { definitionSchema, ScheduleError, scheduleListInput, type Command, type Definition } from '@/lib/schedules/contract'
import type { AutomationHistory, AutomationList, AutomationUsage, AutomationView } from '@/lib/schedules/automation-view'

/**
 * 自动化: the page's commands. Every one goes through the schedules' one writer, `executeScheduleCommand`, as the
 * signed-in person in the workspace they have open, with that workspace's Coordinator as the chat that gets the run
 * reports. Who may list, pause, cancel, update, resume and run is the store's rule, unchanged.
 */
async function command<T>(input: Command, finish?: (workspaceId: string, result: T) => Promise<T>): Promise<ActionResult<T>> {
  return runAction(async () => {
    // A Bot acting for the person names their message instead (schedule tools); only a person uses this page.
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    let actor
    try { actor = await currentWorkspaceActor() } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(isActionErrorCode(error.code) ? error.code : 'generic', undefined, undefined, { cause: error })
      throw error
    }
    const [{ chatBotId }, { executeScheduleCommand }] = await Promise.all([import('@/lib/coordinator/coordinator-bot'), import('@/lib/schedules/runtime')])
    const coordinator = await chatBotId(actor.userId, null, actor.workspaceId, { backfill: false })
    try {
      const result = await executeScheduleCommand(actor.userId, coordinator, undefined, input, { direct: true }) as T
      return finish ? await finish(actor.workspaceId, result) : result
    } catch (error) {
      if (error instanceof ScheduleError) throw new ActionFailureError(isActionErrorCode(error.code) ? error.code : 'generic', undefined, undefined, { cause: error })
      throw error
    }
  })
}

const id = z.uuid()

/** 创建者: each row's creator as the workspace's member list names them (members only read their own workspace). */
async function withCreators(workspaceId: string, list: AutomationList): Promise<AutomationList> {
  const owners = [...new Set(list.schedules.map(row => row.owner_id))]
  if (!owners.length) return list
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows } = await workspacePool.query<{ userId: string; name: string }>('SELECT "userId",name FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[])', [workspaceId, owners])
  const names = new Map(rows.map(row => [row.userId, row.name]))
  return { ...list, schedules: list.schedules.map(row => ({ ...row, owner_name: names.get(row.owner_id) ?? null })) }
}
const versioned = z.object({ scheduleId: z.uuid(), version: z.number().int().positive() }).strict()

/** The workspace's automations, newest first; `cursor` continues a page. */
export async function listAutomations(input: { cursor?: string } = {}): Promise<ActionResult<AutomationList>> {
  const parsed = scheduleListInput.safeParse({ cursor: input.cursor })
  if (!parsed.success) return { error: 'validationGeneric' }
  return command<AutomationList>({ action: 'list', ...parsed.data }, withCreators)
}

/** One automation, or `automation: null` when it is not visible here. */
export async function getAutomation(scheduleId: string): Promise<ActionResult<{ automation: AutomationView | null }>> {
  if (!id.safeParse(scheduleId).success) return { error: 'validationGeneric' }
  const result = await command<AutomationList>({ action: 'list', scheduleId }, withCreators)
  return 'error' in result && result.error ? result : { automation: (result as AutomationList).schedules[0] ?? null }
}

/** Its runs, newest first. Only its creator and owners or admins see each run's result and task. */
export async function automationHistory(scheduleId: string): Promise<ActionResult<AutomationHistory>> {
  if (!id.safeParse(scheduleId).success) return { error: 'validationGeneric' }
  return command({ action: 'history', scheduleId })
}

/** 用量: runs and, for the creator and owners/admins, what the tasks it made spent, per day in its own time zone. */
export async function automationUsage(input: { scheduleId: string; days?: number }): Promise<ActionResult<AutomationUsage>> {
  const parsed = z.object({ scheduleId: z.uuid(), days: z.number().int().min(1).max(90).optional() }).strict().safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  return command({ action: 'usage', ...parsed.data })
}

export async function createAutomation(input: { requestId: string; definition: Definition }): Promise<ActionResult<{ schedule: AutomationView; replayed: boolean }>> {
  const parsed = z.object({ requestId: z.uuid(), definition: definitionSchema }).strict().safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  return command({ action: 'create', ...parsed.data })
}

export async function updateAutomation(input: { scheduleId: string; version: number; definition: Definition }): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.extend({ definition: definitionSchema }).safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  return command({ action: 'update', ...parsed.data })
}

export async function pauseAutomation(input: { scheduleId: string; version: number }): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'pause', ...parsed.data }) : { error: 'validationGeneric' }
}

export async function resumeAutomation(input: { scheduleId: string; version: number }): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'resume', ...parsed.data }) : { error: 'validationGeneric' }
}

/** 删除: cancels every future run. Past runs and the tasks they made stay. */
export async function cancelAutomation(input: { scheduleId: string; version: number }): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'cancel', ...parsed.data }) : { error: 'validationGeneric' }
}

/** 立即运行: one run now. The same `requestId` never starts a second one. */
export async function runAutomationNow(input: { scheduleId: string; version: number; requestId: string }): Promise<ActionResult<{ schedule: AutomationView; replayed: boolean }>> {
  const parsed = versioned.extend({ requestId: z.uuid() }).safeParse(input)
  return parsed.success ? command({ action: 'run_now', ...parsed.data }) : { error: 'validationGeneric' }
}
