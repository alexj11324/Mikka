import 'server-only'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { agentRuns, artifacts } from '@/lib/db/schema'
import { projectDb } from '@/lib/db/projects'
import { requireIssueAccess, requireIssueAccessWithoutBody } from '@/lib/issue-access'
import { readIssueMetadata, type IssuePullRequest } from '@/lib/issue-metadata'
import { accessibleProjects } from '@/lib/project-access'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import type { IssueThread } from '@/lib/issue-threads'
import type { FactoryCheckResult } from '@/lib/factory/task-detail'
import type { FactoryStage, FactoryStatus } from '@/lib/factory/contract'

export type MapStep = 'execute' | 'review' | 'verify' | 'owner'
export type CheckState = 'passed' | 'failed' | 'pending'
export type OwnerState = 'approved' | 'changesRequested' | 'merged'

export interface ProjectMapThread {
  rootRunId: string
  status: string
  outcome: string | null
  ownedByCurrentUser: boolean
  name: string | null
  ownerName: string | null
  harness: string | null
  agentName: string | null
  summary: string | null
  createdAt: string
}

export interface ProjectMapFactory {
  taskId: string
  step: MapStep
  status: FactoryStatus
  review: CheckState | null
  verify: { state: CheckState; passed: number; total: number } | null
  owner: { state: OwnerState; name: string | null; at: string } | null
}

export interface ProjectMapNode {
  id: string
  title: string
  identifier: string | null
  status: string
  createdAt: string
  updatedAt: string
  duplicateOfId: string | null
  parentId: string | null
  blockedByIds: string[]
  pullRequests: IssuePullRequest[]
  threads: ProjectMapThread[]
  artifacts: Array<{ id: string; title: string; kind: string; latestVersion: number; updatedAt: string }>
  factory: ProjectMapFactory | null
  /** Why this step stopped, when it is abandoned: the Owner's note, else the judged outcome. */
  reason: { text: string; source: 'owner' | 'ai' } | null
}

export interface ProjectMapData { projectId: string; nodes: ProjectMapNode[] }

/** Dependencies the reads go through, so a test can stand in for the Factory and threads. */
export interface ProjectMapSources {
  listThreads: (issueId: string) => Promise<IssueThread[]>
  listFactoryTasks: (userId: string, issueId: string) => Promise<{ tasks: Array<{ id: string; stage: FactoryStage; status: FactoryStatus; reason: string | null }> }>
  readFactoryTask: (userId: string, taskId: string) => Promise<{ checks?: FactoryCheckResult[] }>
  readLedger: (userId: string, taskId: string) => Promise<{
    approvals: Array<{ revokedAt: Date | string | null; createdAt: Date | string; userId?: string }>
    rejections: Array<{ note: string | null; actor: { name: string | null } | null; createdAt: Date | string }>
    merges: Array<{ status: string; createdAt: Date | string }>
  }>
}

const CONCURRENCY = 6

async function mapLimited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]) }
  }))
  return results
}

const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : ''
const quiet = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read() } catch { return null } }

export function stepOf(stage: FactoryStage): MapStep {
  if (stage === 'review') return 'review'
  if (stage === 'verify') return 'verify'
  if (stage === 'approval' || stage === 'publish' || stage === 'monitor') return 'owner'
  return 'execute'
}

const checkState = (status: FactoryStatus): CheckState => status === 'passed' ? 'passed' : status === 'failed' || status === 'blocked' ? 'failed' : 'pending'

/** The project the viewer can open in the workspace on screen, or projectNotFound. */
export async function readMapProject(userId: string, projectId: string, workspaceId: string | undefined) {
  const project = (await accessibleProjects(userId, projectDb, workspaceId)).find(item => item.id === projectId)
  if (!project) throw new ActionFailureError('projectNotFound')
  return project
}

export async function readProjectMap(userId: string, projectId: string, workspaceId: string | undefined, sources: ProjectMapSources): Promise<ProjectMapData> {
  const project = await readMapProject(userId, projectId, workspaceId)
  // The task page's own check, per issue: an issue the viewer cannot open is not on the map.
  const opened = (await mapLimited(project.issueIds, id => quiet(() => requireIssueAccessWithoutBody(id)))).filter(value => value !== null)
  const visible = opened.map(found => found.issue)
  if (!visible.length) return { projectId, nodes: [] }
  const ids = visible.map(issue => issue.id)
  const metadata = new Map(visible.map(issue => [issue.id, readIssueMetadata(issue.content as JSONContent)]))
  const identifiers = await taskIdentifiers(visible.map(issue => ({ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: metadata.get(issue.id)!.number })))
  // Artifacts are their owner's (lib/artifacts/store.ts): only the viewer's own, made for the issue or by one of their runs on it.
  const artifactRows = await db.select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind, latestVersion: artifacts.latestVersion, updatedAt: artifacts.updatedAt, issueId: artifacts.issueId, runIssueId: agentRuns.issueId })
    .from(artifacts).leftJoin(agentRuns, and(eq(agentRuns.id, artifacts.runId), eq(agentRuns.userId, userId)))
    .where(and(eq(artifacts.userId, userId), or(inArray(artifacts.issueId, ids), inArray(agentRuns.issueId, ids))))
    .orderBy(desc(artifacts.updatedAt)).limit(500)
  const nodes = await mapLimited(visible, async issue => {
    const meta = metadata.get(issue.id)!
    const [threads, factory] = await Promise.all([
      quiet(() => sources.listThreads(issue.id)).then(value => value ?? []),
      readFactory(userId, issue.id, sources),
    ])
    const own = threads.filter(thread => thread.ownedByCurrentUser)
    const abandoned = issue.status === 'canceled' || issue.status === 'duplicate'
    let reason: ProjectMapNode['reason'] = null
    if (abandoned) {
      if (factory?.note) reason = { text: factory.note, source: 'owner' }
      else if (own[0]) {
        const [run] = await db.select({ reason: agentRuns.outcomeReason }).from(agentRuns).where(and(eq(agentRuns.id, own[0].latestRunId), eq(agentRuns.userId, userId))).limit(1)
        if (run?.reason) reason = { text: run.reason, source: 'ai' }
      }
    }
    return {
      id: issue.id,
      title: issue.title,
      identifier: identifiers.get(issue.id) ?? null,
      status: issue.status,
      createdAt: iso(issue.createdAt),
      updatedAt: iso(issue.updatedAt),
      duplicateOfId: meta.duplicateOfId,
      parentId: meta.parentId,
      blockedByIds: meta.blockedByIds,
      pullRequests: meta.pullRequests,
      threads: threads.map(thread => ({
        rootRunId: thread.rootRunId,
        status: thread.status,
        outcome: thread.outcome ?? null,
        ownedByCurrentUser: thread.ownedByCurrentUser,
        name: thread.detail?.name ?? null,
        ownerName: thread.ownerName,
        harness: thread.detail?.harness ?? null,
        agentName: thread.detail?.agentName ?? null,
        summary: thread.detail?.summary ?? null,
        createdAt: iso(thread.createdAt),
      })),
      artifacts: artifactRows.filter(row => row.issueId === issue.id || row.runIssueId === issue.id)
        .map(row => ({ id: row.id, title: row.title, kind: row.kind, latestVersion: row.latestVersion, updatedAt: iso(row.updatedAt) })),
      factory: factory?.view ?? null,
      reason,
    } satisfies ProjectMapNode
  })
  return { projectId, nodes }
}

async function readFactory(userId: string, issueId: string, sources: ProjectMapSources): Promise<{ view: ProjectMapFactory; note: string | null } | null> {
  const list = await quiet(() => sources.listFactoryTasks(userId, issueId))
  const task = list?.tasks[0]
  if (!task) return null
  const [detail, ledger] = await Promise.all([quiet(() => sources.readFactoryTask(userId, task.id)), quiet(() => sources.readLedger(userId, task.id))])
  const checks = detail?.checks ?? []
  const review = checks.filter(check => check.stage === 'review').at(-1)
  const verify = checks.filter(check => check.stage === 'verify').at(-1)
  const events: Array<{ state: OwnerState; name: string | null; at: string; note: string | null }> = [
    ...(ledger?.approvals ?? []).filter(row => !row.revokedAt).map(row => ({ state: 'approved' as const, name: null, at: iso(row.createdAt), note: null })),
    ...(ledger?.rejections ?? []).map(row => ({ state: 'changesRequested' as const, name: row.actor?.name ?? null, at: iso(row.createdAt), note: row.note?.trim() || null })),
    ...(ledger?.merges ?? []).filter(row => row.status === 'merged').map(row => ({ state: 'merged' as const, name: null, at: iso(row.createdAt), note: null })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const latest = events.at(-1) ?? null
  const note = [...events].reverse().find(event => event.state === 'changesRequested')?.note ?? null
  return {
    view: {
      taskId: task.id,
      step: stepOf(task.stage),
      status: task.status,
      review: review ? checkState(review.status) : null,
      verify: verify ? { state: checkState(verify.status), passed: verify.criteria.filter(item => item.passed).length, total: verify.criteria.length } : null,
      owner: latest ? { state: latest.state, name: latest.name, at: latest.at } : null,
    },
    note: latest?.state === 'changesRequested' ? note : null,
  }
}

/** The description's opening as plain text, for the detail's 任务. */
export function descriptionText(content: JSONContent | null | undefined, limit = 280): string {
  const parts: string[] = []
  let length = 0
  const walk = (node: JSONContent | undefined) => {
    if (!node || length >= limit) return
    if (node.type === 'text' && node.text) { parts.push(node.text); length += node.text.length }
    for (const child of node.content ?? []) walk(child)
    if (['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type ?? '') && parts.length && parts.at(-1) !== ' ') { parts.push(' '); length += 1 }
  }
  walk(content ?? undefined)
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

/** One node's description, once it is picked: the body is read only for that issue. */
export async function readProjectMapNode(userId: string, projectId: string, workspaceId: string | undefined, issueId: string): Promise<{ description: string }> {
  const project = await readMapProject(userId, projectId, workspaceId)
  if (!project.issueIds.includes(issueId)) throw new ActionFailureError('issueNotFound')
  const { issue } = await requireIssueAccess(issueId)
  return { description: descriptionText(issue.content as JSONContent) }
}
