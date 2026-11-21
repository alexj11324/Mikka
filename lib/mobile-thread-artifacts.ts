import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import { readArtifact, listRunArtifacts } from '@/lib/artifacts/store'
import { runEvidence } from '@/lib/captures/store'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { issueForUser } from '@/lib/issue-access'
import { withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { isThreadRun } from '@/lib/issue-threads'
import type { IssueReader } from '@/lib/issue-visibility'
import { readRunChain } from '@/lib/run-chain'
import { taskEvidenceHref } from '@/lib/task-factory-events'
import { THREAD_ARTIFACT_GROUPS, threadArtifacts, type RunArtifactRef, type RunCaptureRef, type ThreadArtifactGroup } from '@/lib/thread-artifacts'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { WorkspaceError } from '@/lib/workspace-error'

/** One row of the iOS thread's Artifact segment: what the phone needs to draw and open it, with no base path in it. */
export type MobileThreadArtifact =
  | { group: 'plans' | 'reports'; id: string; artifactId: string; title: string; version: number; kind: 'markdown' | 'html' }
  | { group: 'pullRequests'; id: string; url: string; state: 'open' | 'draft' | 'merged' | 'closed' | null; title: string | null }
  | { group: 'captures'; id: string; captureId: string; kind: 'image' | 'video'; title: string | null; webPath: string | null }

export type MobileThreadArtifacts = { groups: Record<ThreadArtifactGroup, MobileThreadArtifact[]>; count: number }

type Reader = Exclude<IssueReader, string>

/**
 * What a thread produced, for its Artifact segment on iOS (Alex, 2026-11-15), from the same sources and checks as the
 * web's tab (components/workspace/thread-artifacts.tsx): only the person's own thread. A Factory task's conversation
 * lists the task's receipts and pull requests from the task's work read, under the task's content check; a review or
 * verify child thread only its own runs' receipts; a thread with no Factory task its runs' owner-only evidence. Each
 * document is read again through the Artifact reader, so one the person cannot open is left out. Null: no such thread
 * for this person, or not in the selected workspace.
 */
export async function mobileThreadArtifacts(user: Reader, runId: string, explicitWorkspaceId?: string): Promise<MobileThreadArtifacts | null> {
  const [run] = await db.select({ id: agentRuns.id, issueId: agentRuns.issueId, kind: agentRuns.kind, workspaceId: agentRuns.workspaceId })
    .from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, user.id))).limit(1)
  if (!run || (explicitWorkspaceId !== undefined && run.workspaceId !== explicitWorkspaceId)) return null
  const chain = await readRunChain(pool, user.id, run.id)
  const runIds = chain ? [...new Set([run.id, ...chain.attempts.map(attempt => attempt.runId)])] : [run.id]
  const reader = { ...user, ...(run.workspaceId ? { [tokenWorkspace]: run.workspaceId } : {}), [enterprisePrincipal]: user[enterprisePrincipal] }
  const work = run.issueId ? await taskWork(reader, run.issueId, run.workspaceId) : null
  const factory = work?.factory ?? null
  const conversation = isThreadRun({ kind: run.kind ?? undefined })
  // Without a Factory task: the runs' evidence, read as the web's owner-only evidence route reads it.
  const evidence = factory ? [] : (await Promise.all(runIds.map(id => runEvidence(user.id, id)))).flatMap(found => found ? [found] : [])
  const captures: RunCaptureRef[] = evidence.flatMap(found => found.captures.map(capture => ({ id: capture.id, kind: capture.kind, title: capture.title ?? null,
    url: `/api/captures/${capture.id}`, durationMs: capture.durationMs ?? null, contentType: capture.contentType ?? null })))
  const runArtifacts: RunArtifactRef[] = [...await listRunArtifacts(reader, run.id), ...evidence.flatMap(found => found.artifacts)]
  const groups = threadArtifacts({
    factory: factory?.artifacts ?? null,
    runIds: conversation ? null : runIds,
    pullRequests: conversation && factory ? work?.presentation?.pullRequests ?? [] : [],
    runArtifacts, captures,
  })
  const out: Record<ThreadArtifactGroup, MobileThreadArtifact[]> = { plans: [], pullRequests: [], reports: [], captures: [] }
  for (const group of THREAD_ARTIFACT_GROUPS) for (const item of groups[group]) {
    if (item.group === 'captures') out[group].push({ group: 'captures', id: item.id, captureId: item.id, kind: item.kind, title: item.title,
      webPath: factory && run.issueId ? taskEvidenceHref(run.issueId, factory.task.id, item.id) : null })
    else if (item.group === 'plans' || item.group === 'reports') {
      const found = await readArtifact(reader, item.artifactId)
      if (!found || (found.kind !== 'markdown' && found.kind !== 'html')) continue
      out[group].push({ group: item.group, id: item.id, artifactId: item.artifactId, title: item.title || found.title, version: item.version ?? found.latestVersion, kind: found.kind })
    } else if (item.group === 'pullRequests') out[group].push(item)
  }
  return { groups: out, count: THREAD_ARTIFACT_GROUPS.reduce((total, group) => total + out[group].length, 0) }
}

/** The task's work read under the same tenant and content checks as the task detail (lib/mobile-tasks.ts). */
async function taskWork(reader: Reader, issueId: string, runWorkspaceId: string | null) {
  const candidate = await issueForUser(reader, issueId, false, db, { withoutBody: true })
  // A thread whose task the person can no longer read, or one in another workspace, shows only its own runs' evidence.
  if (!candidate || candidate.ownershipState !== 'bound' || !candidate.workspaceId || candidate.workspaceId !== runWorkspaceId) return null
  const workspaceId = candidate.workspaceId
  try {
    const { withTaskWorkspace } = await import('./task-workspace')
    const { readTaskWork } = await import('./task-work-read')
    return await withTaskWorkspace(reader, workspaceId, async () => {
      const work = await readTaskWork(reader, workspaceId, issueId)
      if (!work.presentation) return null
      await withIssueWorkspace(reader, workspaceId, { issueId, action: 'canReadContent' }, async () => true)
      return work
    })
  } catch (error) {
    if (error instanceof WorkspaceError || (error instanceof ActionFailureError && ['issueNotFound', 'workspaceAccessDenied'].includes(error.code))) return null
    throw error
  }
}
