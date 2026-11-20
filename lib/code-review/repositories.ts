import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { connectForCommitEffects } from '@/lib/db/commit-effects'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { botDefaultOptions, repositoryAvailable } from '@/lib/workspace-admin/bots'
import { workspaceListChanged } from '@/lib/live/lists'
import { coordinatorBot } from '@/lib/coordinator/coordinator-bot'
import { schedules } from '@/lib/schedules/runtime'
import { ScheduleError, type Definition } from '@/lib/schedules/contract'
import type { Schedule } from '@/lib/schedules/store'
import type { SettingsContext } from '@/lib/settings/store'
import { workspaceCodeReviewRepositories } from './settings-schema'
import { reviewRepositoryInput, reviewRepositoryKey, type ReviewRepositoriesView } from './settings-contract'

async function readRepositories(context: SettingsContext): Promise<ReviewRepositoriesView> {
  const rows = await db.select().from(workspaceCodeReviewRepositories).where(eq(workspaceCodeReviewRepositories.workspaceId, context.workspaceId))
  const { repositories: availableRepositories } = await botDefaultOptions(context.workspaceId)
  return { workspaceId: context.workspaceId, repositories: rows.map(row => ({ repository: row.repository, enabled: row.enabled, updatedAt: row.updatedAt.toISOString() })), availableRepositories }
}

export async function getReviewRepositories(context: SettingsContext) {
  return workspaceDb.transaction(async tx => { await requireWorkspace(tx, context.workspaceId, context.userId); return readRepositories(context) })
}

function reviewAutomation(repository: string, agent: 'claude_code' | 'codex', botId: string): Definition {
  return {
    title: `Code review: ${repository.replace('v2/github.com/', '')}`, timezone: 'UTC', timing: { kind: 'manual' },
    task: { kind: 'dispatch_task', botId, agent, prompt: 'Review the pull request named in the GitHub event. Inspect the current diff and report concrete findings without modifying source, pushing commits, approving or merging.' },
    events: ['pull_request_opened', 'pull_request_pushed'].map(event => ({ source: 'github' as const, event: event as 'pull_request_opened' | 'pull_request_pushed', repositories: [repository] })),
    eachRun: 'new_task', misfire: 'skip', maxLatenessMinutes: 60, maxConcurrent: 1,
  }
}

/** The repository row and existing durable automation commit atomically. */
export async function saveReviewRepository(context: SettingsContext, raw: unknown) {
  const input = reviewRepositoryInput.parse(raw)
  return workspaceDb.transaction(async workspaceTx => {
    await requireWorkspace(workspaceTx, context.workspaceId, context.userId, true)
    if (input.enabled && !await repositoryAvailable(context.workspaceId, input.repository)) throw new WorkspaceError('botDefaultRepositoryUnavailable')
    const coordinator = input.enabled ? await coordinatorBot(context.userId, context.workspaceId, { backfill: false }) : null
    const tx = await connectForCommitEffects(pool)
    try {
      await tx.query('BEGIN')
      await withDatabaseClient(tx, async () => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['code-review-repository', context.workspaceId, input.repository])])
        const { rows: [prior] } = await tx.query<{ scheduleId: string | null; ownerId: string }>('SELECT "scheduleId","ownerId" FROM workspace_code_review_repositories WHERE "workspaceId"=$1 AND repository=$2 FOR UPDATE', [context.workspaceId, input.repository])
        const { rows: [schedule] } = prior?.scheduleId ? await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 FOR UPDATE', [prior.scheduleId]) : { rows: [] }
        const actor = { ownerId: context.userId, workspaceId: context.workspaceId, botId: null, direct: true as const }
        let scheduleId = schedule?.id ?? null, ownerId = schedule?.owner_id ?? context.userId
        if (input.enabled && (!schedule || schedule.status_before_delete || schedule.status === 'cancelled')) {
          const { rows: [preference] } = await tx.query<{ preferredHarness: 'claude_code' | 'codex' }>('SELECT "preferredHarness" FROM model_order_settings WHERE "ownerId"=$1 AND "workspaceId"=$2', [context.userId, context.workspaceId])
          const created = await schedules().command(actor, { action: 'create', requestId: `code-review:${randomUUID()}`, definition: reviewAutomation(input.repository, preference?.preferredHarness ?? 'claude_code', coordinator!.botId) }, tx)
          if (!('schedule' in created) || !created.schedule) throw new ScheduleError('scheduleDispatchUnavailable', 503)
          scheduleId = created.schedule.id; ownerId = created.schedule.owner_id
        } else if (input.enabled && schedule?.status === 'paused') {
          await schedules().command(actor, { action: 'resume', scheduleId: schedule.id, version: schedule.version }, tx)
        } else if (!input.enabled && schedule && schedule.status === 'active') {
          await schedules().command(actor, { action: 'pause', scheduleId: schedule.id, version: schedule.version }, tx)
        }
        await tx.query(`INSERT INTO workspace_code_review_repositories ("workspaceId",repository,enabled,"ownerId","scheduleId") VALUES($1,$2,$3,$4,$5)
          ON CONFLICT ("workspaceId",repository) DO UPDATE SET enabled=excluded.enabled,"ownerId"=excluded."ownerId","scheduleId"=excluded."scheduleId","updatedAt"=now()`,
        [context.workspaceId, input.repository, input.enabled, ownerId, scheduleId])
      })
      await tx.query('COMMIT')
    } catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
    await workspaceListChanged(workspaceTx, context.workspaceId, ['workspace_settings'])
    return readRepositories(context)
  })
}

export async function deleteReviewRepository(context: SettingsContext, raw: unknown) {
  const { repository } = z.strictObject({ repository: reviewRepositoryKey }).parse(raw)
  return workspaceDb.transaction(async workspaceTx => {
    await requireWorkspace(workspaceTx, context.workspaceId, context.userId, true)
    const tx = await connectForCommitEffects(pool)
    try {
      await tx.query('BEGIN')
      await withDatabaseClient(tx, async () => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['code-review-repository', context.workspaceId, repository])])
        const { rows: [row] } = await tx.query<{ scheduleId: string | null }>('SELECT "scheduleId" FROM workspace_code_review_repositories WHERE "workspaceId"=$1 AND repository=$2 FOR UPDATE', [context.workspaceId, repository])
        const { rows: [schedule] } = row?.scheduleId ? await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 FOR UPDATE', [row.scheduleId]) : { rows: [] }
        if (schedule && !schedule.status_before_delete) await schedules().command({ ownerId: context.userId, workspaceId: context.workspaceId, botId: null, direct: true }, { action: 'delete', scheduleId: schedule.id, version: schedule.version }, tx)
        await db.delete(workspaceCodeReviewRepositories).where(and(eq(workspaceCodeReviewRepositories.workspaceId, context.workspaceId), eq(workspaceCodeReviewRepositories.repository, repository)))
      })
      await tx.query('COMMIT')
    } catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
    await workspaceListChanged(workspaceTx, context.workspaceId, ['workspace_settings'])
    return readRepositories(context)
  })
}
