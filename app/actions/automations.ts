'use server'

import { z } from 'zod'
import type { LinearLabelOption } from '@/lib/linear-sync/client'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { actingContext } from '@/lib/activity-actor'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { isActionErrorCode } from '@/lib/workspace-admin/action'
import { WorkspaceError } from '@/lib/workspace-access'
import { definitionSchema, ScheduleError, scheduleListInput, webhookBatchListInput, webhookBatchInput, type Command, type Definition } from '@/lib/schedules/contract'
import type { AutomationHistory, AutomationList, AutomationUsage, AutomationView, CancelledAutomationRun, WebhookBatchClosure, WebhookBatchPage } from '@/lib/schedules/automation-view'

/**
 * 自动化: the page's commands. Every one goes through the schedules' one writer, `executeScheduleCommand`, as the
 * signed-in person in the workspace they have open, with that workspace's Coordinator as the chat that gets the run
 * reports. Who may list, pause, cancel, update, resume and run is the store's rule, unchanged.
 */
async function command<T>(input: Command, workspaceId?: string, finish?: (workspaceId: string, result: T) => Promise<T>): Promise<ActionResult<T>> {
  return runAction(async () => {
    // A Bot acting for the person names their message instead (schedule tools); only a person uses this page.
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    if (workspaceId !== undefined && !z.uuid().safeParse(workspaceId).success) throw new ActionFailureError('validationGeneric')
    let actor
    try { actor = await currentWorkspaceActor(workspaceId) } catch (error) {
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
export async function listAutomations(input: { cursor?: string; deleted?: boolean } = {}, workspaceId?: string): Promise<ActionResult<AutomationList>> {
  const parsed = scheduleListInput.safeParse({ cursor: input.cursor, deleted: input.deleted })
  if (!parsed.success) return { error: 'validationGeneric' }
  return command<AutomationList>({ action: 'list', ...parsed.data }, workspaceId, withCreators)
}

/** One automation, or `automation: null` when it is not visible here. */
export async function getAutomation(scheduleId: string, workspaceId?: string): Promise<ActionResult<{ automation: AutomationView | null }>> {
  if (!id.safeParse(scheduleId).success) return { error: 'validationGeneric' }
  const result = await command<AutomationList>({ action: 'list', scheduleId }, workspaceId, withCreators)
  return 'error' in result && result.error ? result : { automation: (result as AutomationList).schedules[0] ?? null }
}

/** Its runs, newest first. Only its creator and owners or admins see each run's result and task. */
export async function automationHistory(scheduleId: string, workspaceId?: string): Promise<ActionResult<AutomationHistory>> {
  if (!id.safeParse(scheduleId).success) return { error: 'validationGeneric' }
  return command({ action: 'history', scheduleId }, workspaceId)
}

type BatchListRequest = Omit<z.input<typeof webhookBatchListInput>, 'cursor'> & { cursor?: string }

export async function automationBatches(input: BatchListRequest, workspaceId?: string): Promise<ActionResult<WebhookBatchPage>> {
  const parsed = webhookBatchListInput.safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  const { scheduleId, limit = 20, cursor, status } = parsed.data
  return command({ action: 'history', scheduleId, batches: { limit, cursor, status } }, workspaceId)
}

export async function flushAutomationBatch(input: z.infer<typeof webhookBatchInput>, workspaceId?: string): Promise<ActionResult<WebhookBatchClosure>> {
  const parsed = webhookBatchInput.safeParse(input)
  return parsed.success ? command({action:'flush_batch', ...parsed.data}, workspaceId) : {error:'validationGeneric'}
}

export async function cancelAutomationBatch(input: z.infer<typeof webhookBatchInput>, workspaceId?: string): Promise<ActionResult<WebhookBatchClosure>> {
  const parsed = webhookBatchInput.safeParse(input)
  return parsed.success ? command({action:'cancel_batch', ...parsed.data}, workspaceId) : {error:'validationGeneric'}
}

/** 用量: runs and, for the creator and owners/admins, what the tasks it made spent, per day in its own time zone. */
export async function automationUsage(input: { scheduleId: string; days?: number }, workspaceId?: string): Promise<ActionResult<AutomationUsage>> {
  const parsed = z.object({ scheduleId: z.uuid(), days: z.number().int().min(1).max(90).optional() }).strict().safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  return command({ action: 'usage', ...parsed.data }, workspaceId)
}

export async function createAutomation(input: { requestId: string; definition: Definition }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView; replayed: boolean }>> {
  const parsed = z.object({ requestId: z.uuid(), definition: definitionSchema }).strict().safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  return command({ action: 'create', ...parsed.data }, workspaceId)
}

export async function updateAutomation(input: { scheduleId: string; version: number; definition: Definition }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.extend({ definition: definitionSchema }).safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  return command({ action: 'update', ...parsed.data }, workspaceId)
}

export async function pauseAutomation(input: { scheduleId: string; version: number }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'pause', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

export async function resumeAutomation(input: { scheduleId: string; version: number }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'resume', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

/** 接手: an owner or admin makes another person's automation theirs; it runs as them from now on. */
export async function takeOverAutomation(input: { scheduleId: string; version: number }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'take_over', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

/** Webhook 地址: a new secret URL key for the automation, returned once; the previous URL stops working. */
export async function automationWebhookKey(input: { scheduleId: string; version: number }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView; key: string }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'webhook_key', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

/** Linear triggers' teams: those of the person's own Linear connection; `connected: false` without one. */
export async function automationLinearTeams(): Promise<ActionResult<{ connected: boolean; teams: { id: string; key: string; name: string }[] }>> {
  return runAction(async () => {
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    const [{ requireUser }, { pool }] = await Promise.all([import('@/lib/issue-access'), import('@/lib/db')])
    const user = await requireUser()
    if (!(await pool.query('SELECT 1 FROM linear_connections WHERE "userId"=$1 AND "revokedAt" IS NULL', [user.id])).rowCount) return { connected: false, teams: [] }
    const [{ linearAccessToken }, { linearTeams }] = await Promise.all([import('@/lib/linear-sync/tokens'), import('@/lib/linear-sync/client')])
    try {
      return { connected: true, teams: (await linearTeams(await linearAccessToken(user.id))).map(({ id, key, name }) => ({ id, key, name })) }
    } catch (error) { throw new ActionFailureError('scheduleLinearUnreachable', undefined, undefined, { cause: error }) }
  })
}

/** Labels for the creator's Linear triggers, fetched only when they edit the label filter. */
export async function automationLinearLabels(workspaceId: string): Promise<ActionResult<{ labels: LinearLabelOption[] }>> {
  return runAction(async () => {
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    if (!z.uuid().safeParse(workspaceId).success) throw new ActionFailureError('validationGeneric')
    let actor
    try { actor = await currentWorkspaceActor(workspaceId) } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(isActionErrorCode(error.code) ? error.code : 'generic', undefined, undefined, { cause: error })
      throw error
    }
    const { pool } = await import('@/lib/db')
    if (!(await pool.query('SELECT 1 FROM linear_connections WHERE "userId"=$1 AND "revokedAt" IS NULL', [actor.userId])).rowCount) return { labels: [] }
    const [{ linearAccessToken }, { linearLabelOptions }] = await Promise.all([import('@/lib/linear-sync/tokens'), import('@/lib/linear-sync/client')])
    try {
      return { labels: await linearLabelOptions(await linearAccessToken(actor.userId)) }
    } catch (error) { throw new ActionFailureError('scheduleLinearUnreachable', undefined, undefined, { cause: error }) }
  })
}

/** Slack triggers' channels: those of the workspace's Slack installation; `installed: false` when the person is not in one. */
export async function automationSlackChannels(workspaceId?: string): Promise<ActionResult<{ installed: boolean; channels: { id: string; name: string; private: boolean }[] }>> {
  return runAction(async () => {
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    const app = process.env.SLACK_APP_ID
    let actor
    try { actor = await currentWorkspaceActor(workspaceId) } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(isActionErrorCode(error.code) ? error.code : 'generic', undefined, undefined, { cause: error })
      throw error
    }
    if (!app) return { installed: false, channels: [] }
    const { slackInstallationChannels } = await import('@/lib/slack/automation-channels')
    try {
      const channels = await slackInstallationChannels(app, actor.userId, actor.workspaceId)
      return channels ? { installed: true, channels } : { installed: false, channels: [] }
    } catch (error) { throw new ActionFailureError('scheduleSlackUnreachable', undefined, undefined, { cause: error }) }
  })
}

/** Custom reaction suggestions for the Slack installation in the workspace shown in the editor. */
export async function automationSlackEmojis(workspaceId: string): Promise<ActionResult<{ emojis: string[] }>> {
  return runAction(async () => {
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    if (!z.uuid().safeParse(workspaceId).success) throw new ActionFailureError('validationGeneric')
    let actor
    try { actor = await currentWorkspaceActor(workspaceId) } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(isActionErrorCode(error.code) ? error.code : 'generic', undefined, undefined, { cause: error })
      throw error
    }
    const app = process.env.SLACK_APP_ID
    if (!app) return { emojis: [] }
    const { slackInstallationEmojis } = await import('@/lib/slack/automation-channels')
    try { return { emojis: await slackInstallationEmojis(app, actor.userId, actor.workspaceId) } }
    catch (error) { throw new ActionFailureError('scheduleSlackUnreachable', undefined, undefined, { cause: error }) }
  })
}

/** One page of eligible Slack trigger authors for the Slack installation in the workspace shown in the editor. */
export async function automationSlackAuthors(workspaceId: string, cursor?: string): Promise<ActionResult<{ users: { id: string; name: string }[]; nextCursor: string | null }>> {
  return runAction(async () => {
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    if (!z.uuid().safeParse(workspaceId).success || !z.string().min(1).max(512).optional().safeParse(cursor).success) throw new ActionFailureError('validationGeneric')
    let actor
    try { actor = await currentWorkspaceActor(workspaceId) } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(isActionErrorCode(error.code) ? error.code : 'generic', undefined, undefined, { cause: error })
      throw error
    }
    const app = process.env.SLACK_APP_ID
    if (!app) return { users: [], nextCursor: null }
    const { slackInstallationAuthors } = await import('@/lib/slack/automation-channels')
    try { return await slackInstallationAuthors(app, actor.userId, actor.workspaceId, cursor) }
    catch (error) { throw new ActionFailureError('scheduleSlackUnreachable', undefined, undefined, { cause: error }) }
  })
}

/** 置顶: the signed-in person's own pin. */
export async function pinAutomation(input: { scheduleId: string; pinned: boolean }, workspaceId?: string): Promise<ActionResult<{ pinned: boolean }>> {
  const parsed = z.object({ scheduleId: z.uuid(), pinned: z.boolean() }).strict().safeParse(input)
  return parsed.success ? command({ action: 'pin', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

/** 文件夹和标签: the workspace's folder and tags for an automation (its creator or an owner/admin). */
export async function organizeAutomation(input: { scheduleId: string; folder: string | null; tags: string[] }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = z.object({ scheduleId: z.uuid(), folder: z.string().trim().min(1).max(60).nullable(), tags: z.array(z.string().trim().min(1).max(30)).max(10) }).strict().safeParse(input)
  return parsed.success ? command({ action: 'organize', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

export async function deleteAutomation(input: { scheduleId: string; version: number }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'delete', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

export async function restoreAutomation(input: { scheduleId: string; version: number }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'restore', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

/** The original terminal cancellation. */
export async function cancelAutomation(input: { scheduleId: string; version: number }): Promise<ActionResult<{ schedule: AutomationView }>> {
  const parsed = versioned.safeParse(input)
  return parsed.success ? command({ action: 'cancel', ...parsed.data }) : { error: 'validationGeneric' }
}

export async function cancelAutomationRun(input: { scheduleId: string; version: number; runId: string }, workspaceId?: string): Promise<ActionResult<CancelledAutomationRun>> {
  const parsed = versioned.extend({ runId: z.uuid() }).safeParse(input)
  return parsed.success ? command({ action: 'cancel_run', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

/** 立即运行: one run now. The same `requestId` never starts a second one. */
export async function runAutomationNow(input: { scheduleId: string; version: number; requestId: string }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView; replayed: boolean }>> {
  const parsed = versioned.extend({ requestId: z.uuid() }).safeParse(input)
  return parsed.success ? command({ action: 'run_now', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}

/** Duplicate to: a copy in this or another workspace of the person's, checked there; `cleared` names what it could not keep. */
export async function duplicateAutomation(input: { scheduleId: string; targetWorkspaceId: string; requestId: string }, workspaceId?: string): Promise<ActionResult<{ schedule: AutomationView; cleared: string[]; replayed: boolean }>> {
  const parsed = z.object({ scheduleId: z.uuid(), targetWorkspaceId: z.uuid(), requestId: z.uuid() }).strict().safeParse(input)
  return parsed.success ? command({ action: 'duplicate', ...parsed.data }, workspaceId) : { error: 'validationGeneric' }
}
