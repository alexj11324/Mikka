import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { workspaceListChanged } from '@/lib/live/lists'
import {
  environmentConfigSchema, EnvironmentRequestError,
  type EnvironmentAction, type EnvironmentConfig, type EnvironmentRuntime, type EnvironmentSaveInput,
} from './contract'

export type EnvironmentRow = {
  id: string
  ownerId: string
  workspaceId: string
  projectId: string | null
  name: string
  description: string
  runtime: EnvironmentRuntime
  workdir: string
  setupScript: string
  installScript: string
  actions: EnvironmentAction[]
  repositories: string[]
  isDefault: boolean
  revision: number
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type EnvironmentActor = { userId: string; workspaceId: string }
const COLUMNS = `id,"ownerId","workspaceId","projectId",name,description,runtime,workdir,"setupScript","installScript",actions,repositories,"isDefault",revision,"archivedAt","createdAt","updatedAt"`

export async function listEnvironmentRows(pool: Pick<Pool, 'query'>, workspaceId: string): Promise<EnvironmentRow[]> {
  const { rows } = await pool.query<EnvironmentRow>(
    `SELECT ${COLUMNS} FROM project_environments
     WHERE "workspaceId"=$1 AND "archivedAt" IS NULL
     ORDER BY "isDefault" DESC, lower(name) LIMIT 50`, [workspaceId])
  return rows
}

export async function readEnvironmentRow(pool: Pick<Pool, 'query'>, workspaceId: string, id: string): Promise<EnvironmentRow | null> {
  const { rows: [row] } = await pool.query<EnvironmentRow>(
    `SELECT ${COLUMNS} FROM project_environments WHERE id=$1 AND "workspaceId"=$2`, [id, workspaceId])
  return row ?? null
}

/**
 * The default environment a run's claim freezes: the project's default when
 * the run's task belongs to one, else the workspace default. A repository
 * allow-list applies before selection; an empty one admits every repository.
 */
export async function defaultEnvironmentForRun(pool: Pick<Pool, 'query'>, input: {
  workspaceId: string; issueId: string | null; repositoryKey: string
}): Promise<EnvironmentRow | null> {
  const { rows: [row] } = await pool.query<EnvironmentRow>(
    `SELECT ${COLUMNS} FROM project_environments e
     WHERE e."workspaceId"=$1 AND e."archivedAt" IS NULL AND e."isDefault"
       AND (jsonb_array_length(e.repositories)=0 OR jsonb_exists(e.repositories,$2))
       AND (e."projectId" IS NULL OR ($3::uuid IS NOT NULL AND EXISTS (
         SELECT 1 FROM workspace_project_tasks t WHERE t."projectId"=e."projectId" AND t."issueId"=$3::uuid)))
     ORDER BY (e."projectId" IS NOT NULL) DESC, e."updatedAt" DESC
     LIMIT 1`, [input.workspaceId, input.repositoryKey, input.issueId])
  return row ?? null
}

async function lockWorkspace(client: PoolClient, actor: EnvironmentActor) {
  if (!(await client.query('SELECT id FROM mikka_workspaces WHERE id=$1 FOR SHARE', [actor.workspaceId])).rowCount)
    throw new EnvironmentRequestError('environmentNotFound', 404)
  const { rows: [member] } = await client.query<{ role: string }>(
    `SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,
    [actor.workspaceId, actor.userId])
  if (member?.role !== 'admin') throw new EnvironmentRequestError('environmentPermissionDenied', 403)
}

async function clearDefault(client: PoolClient, workspaceId: string, projectId: string | null, keepId: string | null) {
  if (projectId) {
    await client.query(`UPDATE project_environments SET "isDefault"=false,"updatedAt"=now()
      WHERE "workspaceId"=$1 AND "projectId"=$2 AND "isDefault" AND "archivedAt" IS NULL AND ($3::uuid IS NULL OR id<>$3)`,
      [workspaceId, projectId, keepId])
    return
  }
  await client.query(`UPDATE project_environments SET "isDefault"=false,"updatedAt"=now()
    WHERE "workspaceId"=$1 AND "projectId" IS NULL AND "isDefault" AND "archivedAt" IS NULL AND ($2::uuid IS NULL OR id<>$2)`,
    [workspaceId, keepId])
}

function revisionConfig(config: EnvironmentConfig, projectId: string | null, isDefault: boolean) {
  return JSON.stringify({ ...config, projectId, isDefault })
}

async function insertRevision(client: PoolClient, environmentId: string, revision: number, config: string, userId: string) {
  await client.query(`INSERT INTO project_environment_revisions ("environmentId",revision,config,"createdBy")
    VALUES ($1,$2,$3::jsonb,$4)`, [environmentId, revision, config, userId])
}

function storageError(error: unknown): EnvironmentRequestError {
  const value = error && typeof error === 'object' ? error as { code?: unknown; constraint?: unknown } : {}
  const constraint = typeof value.constraint === 'string' ? value.constraint : ''
  if (value.code === '23505' && constraint.includes('name')) return new EnvironmentRequestError('environmentNameTaken', 409, { cause: error })
  if (value.code === '23505') return new EnvironmentRequestError('environmentConflict', 409, { cause: error })
  if (value.code === '23503') return new EnvironmentRequestError('environmentProjectUnavailable', 409, { cause: error })
  return new EnvironmentRequestError('environmentUnavailable', 500, { cause: error })
}

export async function saveEnvironment(pool: Pool, actor: EnvironmentActor, input: EnvironmentSaveInput): Promise<EnvironmentRow> {
  const client = await pool.connect()
  let row: EnvironmentRow
  try {
    await client.query('BEGIN')
    await lockWorkspace(client, actor)
    const projectId = input.projectId
    const config = environmentConfigSchema.parse(input.config)
    if (input.id) {
      const { rows: [current] } = await client.query<EnvironmentRow>(
        `SELECT ${COLUMNS} FROM project_environments WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`, [input.id, actor.workspaceId])
      if (!current) throw new EnvironmentRequestError('environmentNotFound', 404)
      if (current.archivedAt) throw new EnvironmentRequestError('environmentConflict', 409)
      if (current.revision !== input.revision) throw new EnvironmentRequestError('environmentConflict', 409)
      if (input.isDefault) await clearDefault(client, actor.workspaceId, projectId, current.id)
      ;({ rows: [row] } = await client.query<EnvironmentRow>(
        `UPDATE project_environments SET "projectId"=$3,name=$4,description=$5,runtime=$6,workdir=$7,
          "setupScript"=$8,"installScript"=$9,actions=$10::jsonb,repositories=$11::jsonb,
          "isDefault"=$12,revision=revision+1,"updatedAt"=now()
         WHERE id=$1 AND "workspaceId"=$2 AND revision=$13
         RETURNING ${COLUMNS}`,
        [current.id, actor.workspaceId, projectId, config.name, config.description, config.runtime, config.workdir,
          config.setupScript, config.installScript, JSON.stringify(config.actions), JSON.stringify(config.repositories),
          input.isDefault, current.revision]))
      if (!row) throw new EnvironmentRequestError('environmentConflict', 409)
    } else {
      const active = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM project_environments WHERE "workspaceId"=$1 AND "archivedAt" IS NULL`, [actor.workspaceId])
      if (active.rows[0]!.count >= 50) throw new EnvironmentRequestError('environmentLimitReached', 409)
      if (input.isDefault) await clearDefault(client, actor.workspaceId, projectId, null)
      const id = crypto.randomUUID()
      ;({ rows: [row] } = await client.query<EnvironmentRow>(
        `INSERT INTO project_environments (id,"ownerId","workspaceId","projectId",name,description,runtime,workdir,
          "setupScript","installScript",actions,repositories,"isDefault")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
         RETURNING ${COLUMNS}`,
        [id, actor.userId, actor.workspaceId, projectId, config.name, config.description, config.runtime, config.workdir,
          config.setupScript, config.installScript, JSON.stringify(config.actions), JSON.stringify(config.repositories), input.isDefault]))
    }
    await insertRevision(client, row!.id, row!.revision, revisionConfig(config, row!.projectId, row!.isDefault), actor.userId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof EnvironmentRequestError) throw error
    throw storageError(error)
  } finally { client.release() }
  // Undefined names read an empty list; nothing has to change for a deleted workspace.
  await workspaceListChanged(pool, actor.workspaceId, ['workspace_settings'])
  return row!
}

export async function archiveEnvironment(pool: Pool, actor: EnvironmentActor, input: { id: string; revision: number }): Promise<EnvironmentRow> {
  const client = await pool.connect()
  let row: EnvironmentRow
  try {
    await client.query('BEGIN')
    await lockWorkspace(client, actor)
    const { rows: [current] } = await client.query<EnvironmentRow>(
      `SELECT ${COLUMNS} FROM project_environments WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`, [input.id, actor.workspaceId])
    if (!current) throw new EnvironmentRequestError('environmentNotFound', 404)
    if (current.archivedAt) throw new EnvironmentRequestError('environmentConflict', 409)
    if (current.revision !== input.revision) throw new EnvironmentRequestError('environmentConflict', 409)
    ;({ rows: [row] } = await client.query<EnvironmentRow>(
      `UPDATE project_environments SET "archivedAt"=now(),"isDefault"=false,revision=revision+1,"updatedAt"=now()
       WHERE id=$1 AND "workspaceId"=$2 AND revision=$3 RETURNING ${COLUMNS}`,
      [current.id, actor.workspaceId, current.revision]))
    if (!row) throw new EnvironmentRequestError('environmentConflict', 409)
    await insertRevision(client, row.id, row.revision, JSON.stringify({
      name: row.name, description: row.description, runtime: row.runtime, workdir: row.workdir,
      setupScript: row.setupScript, installScript: row.installScript, actions: row.actions, repositories: row.repositories,
      projectId: row.projectId, isDefault: false, archived: true,
    }), actor.userId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof EnvironmentRequestError) throw error
    throw storageError(error)
  } finally { client.release() }
  await workspaceListChanged(pool, actor.workspaceId, ['workspace_settings'])
  return row!
}

export type { EnvironmentSaveInput }
