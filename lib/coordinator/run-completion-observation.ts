import { sql } from 'drizzle-orm'
import type { db } from '../db'

interface HostVerification {
  status: string | null; command?: string | null; exitCode?: number | null
  signal?: string | null; timedOut?: boolean | null
}
export interface RunCompletionObservation {
  observedAt: string
  runId: string
  postRunVerify: HostVerification | null
  factory: {
    taskId: string; stage: string; status: string; revision: number; attemptId: string; requestEpoch: string
    runAttempt: { id: string; stage: string; status: string; requestEpoch: string | null }
    candidate: { id: string; sha: string | null } | null
  }
  checks: Array<{ stage: string; status: string; runId: string | null; sessionId: string | null; reportOnly: boolean; postRunVerify: HostVerification | null }>
  publication: { runId: string; status: string; branch: string | null; errorCode: string | null; pullRequest: { url: string; state: string } | null } | null
  repositoryHandoffs: Array<{ previousRunId: string; nextRunId: string; nextStatus: string; from: string | null; to: string | null; previousHead: string }>
}
type CompletionEvent = { kind: string; userId: string; botId: string | null; runId: string | null; issueId: string | null }

/** One current, scoped read at inbox delivery. Historical events/reports stay unchanged.
 * Only persisted Factory bindings supply relationships; event prose cannot grant access. */
export async function runCompletionObservations(executor: Pick<typeof db, 'execute'>, scope: { userId: string; botId: string }, events: readonly CompletionEvent[]) {
  const requested = events.filter(event => event.kind === 'run_finished' && event.userId === scope.userId && event.botId === scope.botId && event.runId)
    .map(event => ({ runId: event.runId, issueId: event.issueId }))
  if (!requested.length) return new Map<string, RunCompletionObservation>()
  const result = await executor.execute(sql`
    SELECT r.id AS "runId", jsonb_build_object(
      'observedAt',clock_timestamp(),'runId',r.id,
      'postRunVerify',CASE WHEN r.report ? 'verify' THEN jsonb_build_object(
        'status',r.report#>'{verify,status}','command',left(r.report#>>'{verify,command}',4000),
        'exitCode',r.report#>'{verify,exitCode}','signal',r.report#>'{verify,signal}','timedOut',r.report#>'{verify,timedOut}') END,
      'factory',jsonb_build_object('taskId',t.id,'stage',t.stage,'status',t.status,'revision',t.revision,'attemptId',t."attemptId",'requestEpoch',t."sourceEventId",
        'runAttempt',jsonb_build_object('id',ended.id,'stage',ended.stage,'status',ended.status,'requestEpoch',ended.output->>'requestEpoch'),
        'candidate',CASE WHEN producer.id IS NOT NULL THEN jsonb_build_object('id',c.id,'sha',c.sha) END),
      'checks',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'stage',a.stage,'status',a.status,'runId',cr.id,'sessionId',cr."sessionId",'reportOnly',COALESCE(a.output#>'{check,reportOnly}'='true'::jsonb,false),
        'postRunVerify',CASE WHEN cr.report ? 'verify' THEN jsonb_build_object(
          'status',cr.report#>'{verify,status}','command',left(cr.report#>>'{verify,command}',4000),
          'exitCode',cr.report#>'{verify,exitCode}','signal',cr.report#>'{verify,signal}','timedOut',cr.report#>'{verify,timedOut}') END) ORDER BY a.stage)
        FROM (SELECT DISTINCT ON (fa.stage) fa.* FROM factory_attempts fa
          WHERE fa."taskId"=t.id AND fa."candidateId"=c.id AND fa.stage IN ('review','verify') ORDER BY fa.stage,fa.position DESC) a
        LEFT JOIN agent_runs cr ON cr.id=a."runId" AND cr."userId"=r."userId" AND cr."botId"=r."botId" AND cr."issueId"=r."issueId"
        WHERE a."runId" IS NULL OR cr.id IS NOT NULL),'[]'::jsonb),
      'publication',CASE WHEN p."runId" IS NOT NULL THEN jsonb_build_object('runId',p."runId",'status',p.status,
        'branch',p.branch,'errorCode',p."errorCode",'pullRequest',CASE WHEN p."pullRequest" IS NOT NULL THEN
          jsonb_build_object('url',p."pullRequest"->>'url','state',p."pullRequest"->>'state') END) END,
      'repositoryHandoffs',COALESCE((SELECT jsonb_agg(link.handoff ORDER BY link.position) FROM (
        SELECT h.position,jsonb_build_object('previousRunId',previous.id,'nextRunId',successor.id,'nextStatus',successor.status,
          'from',original."remoteUrl",'to',target."remoteUrl",'previousHead',h.output#>>'{repositorySelection,observedHead}') AS handoff
        FROM factory_attempts h
        JOIN agent_runs previous ON previous.id=h."runId" AND previous."userId"=r."userId" AND previous."botId"=r."botId" AND previous."issueId"=r."issueId"
        JOIN agent_runs successor ON successor."continuesRunId"=previous.id AND successor."userId"=r."userId" AND successor."botId"=r."botId" AND successor."issueId"=r."issueId"
        JOIN factory_attempts successor_attempt ON successor_attempt."runId"=successor.id AND successor_attempt."taskId"=t.id AND successor_attempt.stage='execute'
        LEFT JOIN device_repos original ON original.id=previous."deviceRepoId" AND original."userId"=r."userId"
        LEFT JOIN device_repos target ON target.id=successor."deviceRepoId" AND target."userId"=r."userId"
        WHERE h."taskId"=t.id AND h.stage='execute' AND h.status='blocked'
          AND h.output#>>'{repositorySelection,previousRunId}'=previous.id::text
        ORDER BY h.position DESC LIMIT 3) link),'[]'::jsonb)
    ) AS observation
    FROM jsonb_to_recordset(${JSON.stringify(requested)}::jsonb) AS requested("runId" uuid,"issueId" uuid)
    JOIN agent_runs r ON r.id=requested."runId" AND r."issueId" IS NOT DISTINCT FROM requested."issueId"
      AND r."userId"=${scope.userId} AND r."botId"=${scope.botId}::uuid
    JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."userId"
    JOIN factory_attempts ended ON ended."runId"=r.id
    JOIN factory_tasks t ON t.id=ended."taskId" AND t."userId"=r."userId" AND t."issueId"=r."issueId"
      -- The existing factoryRunBotMatches grant permits a separate chat Bot
      -- only through this run's owned computer binding in the same workspace.
      AND (t."botId"=r."botId" OR EXISTS (
        SELECT 1 FROM computer_run_bindings binding JOIN bots source ON source.id=t."botId"
          AND source."ownerId"=binding."ownerId" AND source."workspaceId"=binding."workspaceId"
        WHERE binding."runId"=r.id AND binding."ownerId"=r."userId" AND binding."botId"=r."botId"))
    LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
    LEFT JOIN agent_runs producer ON producer.id=c."runId" AND producer."userId"=r."userId" AND producer."botId"=r."botId" AND producer."issueId"=r."issueId"
    -- advanceFactoryRequest stamps every older attempt before replacing the
    -- source and clearing the candidate. An unstamped attempt is legacy; a
    -- stamped predecessor can never supply a new request's current PR.
    LEFT JOIN run_publications p ON p."runId"=COALESCE(producer.id,
      CASE WHEN COALESCE(ended.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text THEN r.id END)
      AND p."userId"=r."userId" AND p."issueId"=r."issueId"
  `)
  return new Map((result.rows as Array<{ runId: string; observation: RunCompletionObservation }>).map(row => [row.runId, row.observation]))
}
