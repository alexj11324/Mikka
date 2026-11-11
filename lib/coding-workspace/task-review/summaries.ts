import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { diffSnapshot, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { pool } from '../../db'
import { workspacePool } from '../../workspace-db'
import { actingContext } from '../../activity-actor'
import { issuesForUser } from '../../issues-for-user'
import type { IssueReader } from '../../issue-visibility'
import { tokenWorkspace } from '../../tokens/principal'
import { UNFINISHED_RUN_STATUSES } from '../../agent-run-statuses'
import { secretMaskerFor } from '../../secrets/runtime'
import { maskDeep, type Masker } from '../../secrets/mask'
import type { ReviewActor, ReviewScope } from '../diff/authority'
import { reviewBoardId } from '../diff/board-id'
import { observedReviewChecks } from './github-checks'
import { projectTaskReviewSummary, type TaskReviewSummary, type TaskSummaryChecks, type TaskSummaryFacts } from './projection'

type Candidate = { taskId: string; candidateId: string; producerRunId: string; sha: string | null; kind: string; repository: string; skill: boolean }
type SourceRow = { taskId: string; ownerId: string; runId: string; status: string; stopped: boolean; repoId: string | null;
  repositoryKey: string | null; remoteUrl: string | null; workspaceId: string | null; bindings: number;
  deviceRepoId: string | null; frozenWorkspace: string | null; admissionWorkspace: string | null; machineWorkspace: string | null;
  frozenKey: string | null; publicationKey: string | null; publication: { url?: string } | null; branch: string | null;
  reclaimed: boolean; candidates: Candidate[] }
type Source = { scope: ReviewScope; row: SourceRow; active: boolean; number: number | null; factory: DiffSnapshot['factory'] | null }
type SnapshotRow = TaskSummaryFacts & { taskId: string; snapshot: unknown | null; files: number; additions: number; deletions: number;
  complete: boolean; observation: unknown | null; maskPolicy: string | null; viewerMaskPolicy: string | null }

/** Task cards read retained public metadata in bulk. They never fetch a
 * daemon, GitHub source or logs, or choose a viewer's/another Bot's thread.
 * Full review reads and every action still obtain their own current lease. */
export async function taskReviewSummaries(reader: IssueReader, taskIds: readonly string[], workspaceId?: string): Promise<Map<string, TaskReviewSummary>> {
  const result = new Map<string, TaskReviewSummary>()
  const wanted = [...new Set(taskIds)].filter(id => z.uuid().safeParse(id).success)
  if (!wanted.length) return result
  const userId = typeof reader === 'string' ? reader : reader.id, acting = actingContext.getStore()
  const token = typeof reader === 'string' ? (acting?.userId === userId ? acting.tokenWorkspaceId : undefined) : reader[tokenWorkspace]
  const selectedWorkspace = token ?? workspaceId
  const scopedReader: IssueReader = selectedWorkspace ? { id: userId, [tokenWorkspace]: selectedWorkspace } : reader
  const tasks = await issuesForUser(scopedReader, wanted, false, undefined, { withoutBody: true })
  if (!tasks.size) return result
  const { rows } = await pool.query<SourceRow>(`SELECT i.id AS "taskId",i."userId" AS "ownerId",r.id AS "runId",r.status,
    r."stopRequestedAt" IS NOT NULL AS stopped,r."deviceRepoId",coalesce(b."repoId",p.id) AS "repoId",
    coalesce(b."repositoryKey",p."repoPath") AS "repositoryKey",p."remoteUrl",coalesce(b.count,0)::int AS bindings,
    coalesce(b."workspaceId"::text,r."agentDefinition"#>>'{executionIdentity,workspaceId}',
      r."agentDefinition"#>>'{repositoryAdmission,workspaceId}',m."workspaceId"::text) AS "workspaceId",
    r."agentDefinition"#>>'{executionIdentity,workspaceId}' AS "frozenWorkspace",
    r."agentDefinition"#>>'{repositoryAdmission,workspaceId}' AS "admissionWorkspace",m."workspaceId"::text AS "machineWorkspace",
    r."agentDefinition"#>>'{repositoryAdmission,remoteKey}' AS "frozenKey",pub."remoteKey" AS "publicationKey",
    CASE WHEN pub.status='published' THEN pub."pullRequest" END AS publication,pub.branch,
    coalesce(m.state='ended' AND m."sandboxId" IS NULL,false) AS reclaimed,coalesce(c.candidates,'[]'::jsonb) AS candidates
    FROM issues i JOIN LATERAL (
      SELECT r.* FROM agent_runs r JOIN agents a ON a.id=r."agentId" WHERE r."issueId"=i.id AND r."userId"=i."userId"
        AND r.kind<>'group_chat' AND NOT EXISTS(SELECT 1 FROM factory_attempts a WHERE a."runId"=r.id AND a.stage IN ('review','verify','monitor'))
      ORDER BY r."createdAt" DESC,r.id DESC LIMIT 1
    ) r ON true LEFT JOIN LATERAL (
      SELECT (array_agg("repoId"))[1] AS "repoId",(array_agg("workspaceId"))[1] AS "workspaceId",
        (array_agg("repositoryKey"))[1] AS "repositoryKey",count(*) AS count
      FROM coding_workspace_bindings WHERE "runId"=r.id AND "ownerId"=i."userId"
    ) b ON true LEFT JOIN device_repos p ON p.id=r."deviceRepoId" AND p."userId"=r."userId" AND p."deviceId"=r."deviceId"
    LEFT JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=r."userId"
    LEFT JOIN run_publications pub ON pub."runId"=r.id AND pub."userId"=r."userId" AND pub."issueId"=i.id
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('taskId',c."taskId",'candidateId',c.id,'producerRunId',c."runId",
      'sha',c.sha,'kind',c.kind,'repository',c.repository,'skill',EXISTS(SELECT 1 FROM improvement_skill_candidates sc WHERE sc."candidateId"=c.id))) AS candidates
      FROM factory_candidates c JOIN factory_tasks t ON t.id=c."taskId" AND t."issueId"=i.id AND t."userId"=i."userId" WHERE c."runId"=r.id
    ) c ON true WHERE i.id=ANY($1::uuid[])`, [[...tasks.keys()]])
  const sources = new Map<string, Source>()
  for (const row of rows) {
    if (tasks.get(row.taskId)?.userId !== row.ownerId || !row.repoId || !row.repositoryKey || !z.uuid().safeParse(row.workspaceId).success
      || row.bindings > 1 || (row.bindings && row.deviceRepoId && row.repoId !== row.deviceRepoId)
      || (selectedWorkspace && row.workspaceId !== selectedWorkspace)
      || [row.frozenWorkspace, row.admissionWorkspace, row.machineWorkspace].some(value => value && value !== row.workspaceId)
      || [row.frozenKey, row.publicationKey].some(value => value && value !== row.repositoryKey)
      || (!row.bindings && (!row.frozenKey && !row.publicationKey || !repositoryBindingMatches(row.repositoryKey, row.remoteUrl, { allowFile: true })))) continue
    const identity = { version: 1 as const, runId: row.runId, repoId: row.repoId, ownerId: row.ownerId,
      workspaceId: row.workspaceId!, repositoryKey: row.repositoryKey }
    const scope: ReviewScope = { identity, taskId: row.taskId, boardId: reviewBoardId(identity, row.taskId), status: row.status, stopped: row.stopped }
    const link = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(row.publication?.url ?? '')
    let number = link && `v2/github.com/${link[1]!.toLowerCase()}` === row.repositoryKey && Number.isSafeInteger(Number(link[2])) ? Number(link[2]) : null
    let factory: DiffSnapshot['factory'] | null = null
    if (row.candidates.length) {
      const candidate = row.candidates[0]!
      if (row.candidates.length !== 1 || candidate.skill || candidate.kind !== 'repository' || !candidate.sha
        || (candidate.repository.startsWith('v2/') ? candidate.repository !== row.repositoryKey
          : !repositoryBindingMatches(row.repositoryKey, /^[\w.-]+\/[\w.-]+$/.test(candidate.repository)
            ? `https://github.com/${candidate.repository}.git` : candidate.repository, { allowFile: true }))) number = null
      else factory = { taskId: candidate.taskId, candidateId: candidate.candidateId, producerRunId: candidate.producerRunId, sha: candidate.sha }
    }
    sources.set(row.taskId, { scope, row, number, factory, active: !row.stopped && UNFINISHED_RUN_STATUSES.some(status => status === row.status) })
  }
  if (!sources.size) return result
  const selections = [...sources.values()].map(({ scope, number, factory, active }) => ({ ...scope.identity, taskId: scope.taskId, boardId: scope.boardId, number, factory, active }))
  const { rows: snapshots } = await pool.query<SnapshotRow>(`WITH wanted AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
    "taskId" uuid,"runId" uuid,"repoId" uuid,"ownerId" text,"workspaceId" uuid,"boardId" text,number int,factory jsonb,active boolean))
    SELECT x."taskId",s.snapshot,counts.*,o.observation,o."maskPolicy",o."viewerMaskPolicy",ps.observation AS "pullObservation",
      t.stage='approval' AND t.status IN ('pending','waiting') AND c.sha=s.snapshot#>>'{factory,sha}'
        AND c."runId"::text=s.snapshot#>>'{factory,producerRunId}'
        AND NOT EXISTS(SELECT 1 FROM factory_merges fm WHERE fm."taskId"=t.id AND fm.status IN ('merging','merged')) AS "canMerge",
      EXISTS(SELECT 1 FROM factory_merges fm WHERE fm."taskId"=t.id AND fm."candidateId"=c.id AND fm.status IN ('merging','merged')) AS merging,
      CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('taskId',t.id,'issueId',t."issueId",'attemptId',t."attemptId",'revision',t.revision,'candidateId',t."candidateId") END AS "mergeBinding"
    FROM wanted x LEFT JOIN coding_workspace_checkpoint_reviews cp ON cp."runId"=x."runId" AND cp."repoId"=x."repoId" AND cp."workspaceId"=x."workspaceId"
    LEFT JOIN LATERAL (SELECT s.* FROM coding_workspace_snapshots s
      WHERE s."runId"=x."runId" AND s."repoId"=x."repoId" AND s."ownerId"=x."ownerId" AND s."workspaceId"=x."workspaceId" AND s."boardId"=x."boardId"
        AND ((s.source='pull_request' AND s.snapshot->'pullRequest'->>'number'=x.number::text AND coalesce(s.snapshot->'factory','null'::jsonb)=coalesce(x.factory,'null'::jsonb))
          OR (x.active AND s.source='working') OR (NOT x.active AND cp.reason IS NULL AND s.id=cp."snapshotId"))
      ORDER BY (s.source='pull_request') DESC,s."createdAt" DESC,s.id DESC LIMIT 1
    ) s ON true LEFT JOIN LATERAL (SELECT count(f.path)::int AS files,
      coalesce(sum(coalesce((f.patch->'file'->>'additions')::int,(f.metadata->>'additions')::int)),0)::int AS additions,
      coalesce(sum(coalesce((f.patch->'file'->>'deletions')::int,(f.metadata->>'deletions')::int)),0)::int AS deletions,
      coalesce(bool_and(f.patch IS NOT NULL AND f.patch->>'format' IN ('text','binary')),true) AS complete
      FROM coding_workspace_snapshot_files f WHERE f."snapshotId"=s.id
    ) counts ON true LEFT JOIN LATERAL (SELECT observation,"maskPolicy","viewerMaskPolicy" FROM coding_workspace_check_observations
      WHERE "snapshotId"=s.id AND "boardId"=x."boardId" AND "workspaceId"=x."workspaceId" AND "userId"=$2 ORDER BY "createdAt" DESC,id DESC LIMIT 1
    ) o ON true LEFT JOIN factory_tasks t ON t.id::text=s.snapshot#>>'{factory,taskId}' AND t."issueId"=x."taskId" AND t."userId"=x."ownerId"
    LEFT JOIN coding_workspace_pull_states ps ON ps."snapshotId"=s.id AND ps."userId"=$2 AND ps."workspaceId"=x."workspaceId"
    LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id AND c.id::text=s.snapshot#>>'{factory,candidateId}'`, [JSON.stringify(selections), userId])
  const masks = new Map<string, Promise<Masker>>()
  const maskFor = (workspaceId: string, ownerId: string) => {
    const key = JSON.stringify([workspaceId, ownerId])
    if (!masks.has(key)) masks.set(key, secretMaskerFor({ workspaceId, ownerId }))
    return masks.get(key)!
  }
  for (const row of snapshots) {
    const source = sources.get(row.taskId)!, { scope } = source
    const pair = await Promise.all([maskFor(scope.identity.workspaceId, scope.identity.ownerId), maskFor(scope.identity.workspaceId, userId)])
    const parsed = row.snapshot ? diffSnapshot.safeParse(row.snapshot) : null
    if (parsed && (!parsed.success || !isDeepStrictEqual(parsed.data.identity, scope.identity) || parsed.data.taskId !== scope.taskId)) continue
    const snapshot = parsed?.success ? { ...parsed.data, counts: { files: row.files, additions: row.additions,
      deletions: row.deletions, complete: row.complete && parsed.data.availability !== 'unavailable' } } : null
    let checks: TaskSummaryChecks = null
    if (snapshot && row.observation && row.maskPolicy === pair[0]!.sourcePolicy && row.viewerMaskPolicy === pair[1]!.sourcePolicy) {
      const observed = observedReviewChecks.safeParse(row.observation)
      if (observed.success && observed.data.headSha === snapshot.revision.headSha && observed.data.repositoryId === snapshot.sourceAccess?.repositoryId)
        checks = { ...observed.data.counts, sha: observed.data.headSha, observedAt: observed.data.observedAt, fingerprint: observed.data.fingerprint }
    }
    const actor: ReviewActor = { userId, workspaceId: scope.identity.workspaceId, credential: { kind: token ? 'pat' : 'session', id: 'summary' } }
    const summary = projectTaskReviewSummary(actor, scope, snapshot, { ...row, branch: source.row.branch, reclaimed: source.row.reclaimed }, checks)
    if (pair.some(mask => !isDeepStrictEqual(maskDeep(summary, mask), summary))) continue
    result.set(row.taskId, summary)
  }
  // The two databases remain separate. Recheck membership and Task visibility
  // after awaiting masking; frozen Run tenancy cannot follow a moved Task.
  const [visible, membership] = await Promise.all([
    issuesForUser(scopedReader, [...result.keys()], false, undefined, { withoutBody: true }),
    workspacePool.query<{ taskId: string; kind: string; linked: boolean; elsewhere: boolean }>(`SELECT x."taskId",w.kind,
      EXISTS(SELECT 1 FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId"
        WHERE l."issueId"=x."taskId" AND l."workspaceId"=x."workspaceId") AS linked,
      EXISTS(SELECT 1 FROM mikka_team_issues l WHERE l."issueId"=x."taskId" AND l."workspaceId"<>x."workspaceId") AS elsewhere
      FROM jsonb_to_recordset($1::jsonb) AS x("taskId" uuid,"workspaceId" uuid)
      JOIN mikka_workspaces w ON w.id=x."workspaceId" JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$2 AND m.status='active'`,
    [JSON.stringify(selections), userId]),
  ])
  const authorized = new Map(membership.rows.map(row => [row.taskId, row]))
  for (const id of result.keys()) {
    const task = visible.get(id), access = authorized.get(id), source = sources.get(id)!
    if (!task || task.userId !== source.row.ownerId || !access
      || (access.kind === 'personal' ? task.userId !== userId || task.scope === 'workspace' && access.elsewhere : !access.linked)) result.delete(id)
  }
  return result
}
