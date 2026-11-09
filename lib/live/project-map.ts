import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'
import { bumpLiveRevisions, liveRevisionKey, withLiveRevisions, type LiveRevisions } from './revisions'

type Database = Pick<PoolClient, 'query'>
type Reference = { projectId: string } | { issueId: string } | { runId: string } | { taskId: string } | { artifactId: string }
type Cursor = { projectId: string; ownerId: string; workspaceId: string }
type Target = { scope: LiveScope; events: LiveInvalidation[] }
const PAGE = 100

/** Current project membership only. Each finite page is at most 101 small IDs;
 * neither a private source nor a title crosses a live channel. */
export async function projectMapTargets(workspace: Database, reference: { projectId: string } | { issueId: string }, after?: Cursor) {
  const { rows } = await workspace.query<Cursor>(`SELECT DISTINCT p.id AS "projectId",m."userId" AS "ownerId",w.id AS "workspaceId"
    FROM workspace_projects p JOIN mikka_workspaces w ON w.id=p."workspaceId"
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m.status='active'
      AND (w.kind<>'personal' OR m."userId"=w."userId")
    WHERE ($1::uuid IS NULL OR p.id=$1) AND ($2::uuid IS NULL OR EXISTS (
      SELECT 1 FROM workspace_project_tasks relation WHERE relation."projectId"=p.id
        AND relation."workspaceId"=p."workspaceId" AND relation."issueId"=$2))
      AND ($3::uuid IS NULL OR (p.id,m."userId",w.id)>($3::uuid,$4::text,$5::uuid))
    ORDER BY p.id,m."userId",w.id LIMIT 101`,
    ['projectId' in reference ? reference.projectId : null, 'issueId' in reference ? reference.issueId : null,
      after?.projectId ?? null, after?.ownerId ?? null, after?.workspaceId ?? null])
  const page = rows.slice(0, PAGE)
  return { targets: page.map(row => ({ scope: { ownerId: row.ownerId, workspaceId: row.workspaceId },
    events: [{ kind: 'project_map', id: row.projectId }] } satisfies Target)), next: rows.length > PAGE ? page.at(-1)! : null }
}

async function publish(database: Database, workspace: Database, reference: Reference) {
  let references: ({ projectId: string } | { issueId: string })[]
  if ('projectId' in reference || 'issueId' in reference) references = [reference]
  else if ('artifactId' in reference) {
    // A submission receipt preserves its original issue even after the Artifact is deleted.
    const { rows } = await database.query<{ issueId: string }>(`SELECT DISTINCT "issueId" FROM (
      SELECT "issueId" FROM artifacts WHERE id=$1
      UNION ALL SELECT "issueId" FROM coordinator_events WHERE kind='artifact_submitted'
        AND payload->>'artifactId'=$1::text AND "dedupeKey" LIKE 'artifact_submitted:'||$1::text||':%'
    ) sources WHERE "issueId" IS NOT NULL ORDER BY "issueId" LIMIT 100`, [reference.artifactId])
    references = rows.map(({ issueId }) => ({ issueId }))
  } else {
    const { rows: [row] } = 'runId' in reference
      ? await database.query<{ issueId: string | null }>('SELECT "issueId" FROM agent_runs WHERE id=$1 LIMIT 1', [reference.runId])
      : await database.query<{ issueId: string | null }>('SELECT "issueId" FROM factory_tasks WHERE id=$1 LIMIT 1', [reference.taskId])
    references = row?.issueId ? [{ issueId: row.issueId }] : []
  }
  const { sendLiveInvalidations } = await import('./notify')
  const raised = new Set<string>(), revisions: LiveRevisions = {}
  for (const reference of references) {
    let cursor: Cursor | undefined
    do {
      const page = await projectMapTargets(workspace, reference, cursor)
      // Raise a project key once for the entire finite, paged fan-out. Each
      // recipient receives that same committed revision, including later pages.
      const fresh = page.targets.flatMap(target => target.events).filter(event => {
        const key = liveRevisionKey(event.kind, event.id)
        if (raised.has(key)) return false
        raised.add(key); return true
      })
      if (fresh.length) {
        try { Object.assign(revisions, await bumpLiveRevisions(database, fresh)) }
        catch (error) { console.warn('[live] project map revision unavailable', { name: (error as Error | undefined)?.name, code: (error as { code?: string } | undefined)?.code }) }
      }
      const merged = new Map<string, Target>()
      for (const target of page.targets) {
        const key = JSON.stringify(target.scope), previous = merged.get(key)
        if (previous) previous.events.push(...target.events)
        else merged.set(key, target)
      }
      for (const { scope, events } of merged.values())
        for (let offset = 0; offset < events.length; offset += 16) await sendLiveInvalidations(scope, withLiveRevisions(events.slice(offset, offset + 16), revisions))
      cursor = page.next ?? undefined
    } while (cursor)
  }
}
async function changed(executor: object, reference: Reference) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive } = await import('./notify')
  afterDatabaseCommit(executor, 'project-map:' + JSON.stringify(reference), () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(() => publish(pool, workspacePool, reference))
  }))
}
export const projectMapChanged = (executor: object, projectId: string) => changed(executor, { projectId })
export const projectMapIssueChanged = (executor: object, issueId: string) => changed(executor, { issueId })
export const projectMapRunChanged = (executor: object, runId: string) => changed(executor, { runId })
export const projectMapTaskChanged = (executor: object, taskId: string) => changed(executor, { taskId })
export const projectMapArtifactChanged = (executor: object, artifactId: string) => changed(executor, { artifactId })
