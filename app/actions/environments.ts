'use server'

import { z } from 'zod'
import { WorkspaceError } from '@/lib/workspace-access'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { accessibleProjectReferences, accessibleProjects } from '@/lib/project-access'
import { projectDb } from '@/lib/db/projects'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { boundRunCounts, latestExecutionByEnvironment, eligibleActionRuns, type EligibleActionRun } from '@/lib/environments/runs'
import {
  archiveEnvironment as archiveStoredEnvironment, listEnvironmentRows, saveEnvironment as saveStoredEnvironment,
  type EnvironmentRow,
} from '@/lib/environments/store'
import {
  environmentSaveInputSchema, normalizeEnvironmentRepositories,
  type EnvironmentAction, type EnvironmentRuntime, type RunActionExecutionSummary,
} from '@/lib/environments/contract'

export type EnvironmentView = {
  id: string
  name: string
  description: string
  projectId: string | null
  projectName: string | null
  runtime: EnvironmentRuntime
  workdir: string
  setupScript: string
  installScript: string
  actions: EnvironmentAction[]
  repositories: string[]
  isDefault: boolean
  revision: number
  boundRunCount: number
  updatedAt: string
  lastExecution: RunActionExecutionSummary | null
}

export type EnvironmentsView = {
  environments: EnvironmentView[]
  projects: { id: string; name: string }[]
  canManage: boolean
  eligibleRuns: EligibleActionRun[]
}

async function actor(workspaceId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId, user)
  return { user, userId: user.id, workspaceId: context.workspace.id, role: context.role }
}

function view(row: EnvironmentRow, projectName: string | null, lastExecution: RunActionExecutionSummary | null, boundRunCount = 0): EnvironmentView {
  return {
    id: row.id, name: row.name, description: row.description, projectId: row.projectId, projectName,
    runtime: row.runtime, workdir: row.workdir, setupScript: row.setupScript, installScript: row.installScript,
    actions: row.actions, repositories: row.repositories, isDefault: row.isDefault, revision: row.revision,
    boundRunCount, updatedAt: row.updatedAt.toISOString(), lastExecution,
  }
}

function storeFailure(error: unknown): never {
  if (error instanceof WorkspaceError) throw error
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
  if (typeof code === 'string' && code.startsWith('environment')) throw new WorkspaceError(code, { cause: error })
  throw new WorkspaceError('environmentSaveFailed')
}

/** 设置 › 运行环境: everything the section shows in one authorized read. */
export async function listEnvironments(workspaceId?: string): Promise<SettingsActionResult<EnvironmentsView>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    const [rows, projects, latest, runs, bound] = await Promise.all([
      listEnvironmentRows(workspacePool, current.workspaceId),
      accessibleProjects(current.user, projectDb, current.workspaceId).then(items => items.map(project => ({ id: project.id, name: project.name }))),
      latestExecutionByEnvironment(pool, current.workspaceId),
      eligibleActionRuns(pool, current.workspaceId, current.userId),
      boundRunCounts(pool, current.workspaceId),
    ])
    const names = new Map(projects.map(project => [project.id, project.name]))
    return {
      environments: rows.map(row => view(row, row.projectId ? names.get(row.projectId) ?? null : null, latest.get(row.id) ?? null, bound.get(row.id) ?? 0)),
      projects,
      canManage: current.role === 'admin',
      eligibleRuns: runs,
    }
  })
}

export async function saveEnvironment(input: unknown, workspaceId?: string): Promise<SettingsActionResult<{ environment: EnvironmentView }>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    if (current.role !== 'admin') throw new WorkspaceError('environmentPermissionDenied')
    const parsed = environmentSaveInputSchema.safeParse(input)
    if (!parsed.success) throw new WorkspaceError('environmentInvalid')
    if (parsed.data.projectId) {
      const references = await accessibleProjectReferences(current.user, current.workspaceId)
      if (!references.some(reference => reference.id === parsed.data.projectId)) throw new WorkspaceError('environmentProjectUnavailable')
    }
    let repositories: string[]
    try { repositories = normalizeEnvironmentRepositories(parsed.data.config.repositories) }
    catch (error) { throw new WorkspaceError('environmentInvalid', { cause: error }) }
    try {
      const row = await saveStoredEnvironment(workspacePool, { userId: current.userId, workspaceId: current.workspaceId }, {
        ...parsed.data, config: { ...parsed.data.config, repositories },
      })
      const projects = await accessibleProjects(current.user, projectDb, current.workspaceId)
      return { environment: view(row, row.projectId ? projects.find(project => project.id === row.projectId)?.name ?? null : null, null) }
    } catch (error) { storeFailure(error) }
  })
}

export async function archiveEnvironment(input: { id: string; revision: number }, workspaceId?: string): Promise<SettingsActionResult<{ environment: EnvironmentView }>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    if (current.role !== 'admin') throw new WorkspaceError('environmentPermissionDenied')
    const parsed = z.strictObject({ id: z.uuid(), revision: z.number().int().positive() }).safeParse(input)
    if (!parsed.success) throw new WorkspaceError('environmentInvalid', { cause: parsed.error })
    try {
      const row = await archiveStoredEnvironment(workspacePool, { userId: current.userId, workspaceId: current.workspaceId }, parsed.data)
      const projects = await accessibleProjects(current.user, projectDb, current.workspaceId)
      return { environment: view(row, row.projectId ? projects.find(project => project.id === row.projectId)?.name ?? null : null, null) }
    } catch (error) { storeFailure(error) }
  })
}
