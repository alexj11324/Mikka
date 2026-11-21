import { MAP_NODE_LIMIT, MAP_SOURCE_LIMIT } from './read-contracts'
import { currentSourceAccessSql } from './source-access'
import { compactMapRowsSql } from './read-transport'

// These remain the full logical projections. Their original object sizes, not
// any transport encoding, enforce the cumulative metadata budget in PostgreSQL.
const projections = [
  `SELECT id,left(title,200) AS title,status,"createdAt", COALESCE(content->'attrs'->'mikka'->'blockedByIds',content->'attrs'->'orvilo'->'blockedByIds','[]'::jsonb) AS "blockedByIds" FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id LIMIT $4`,
  `SELECT r.id,r."issueId",r.status,CASE WHEN r.status IN ('succeeded','failed','stopped') THEN r.outcome ELSE NULL END AS outcome,r."createdAt",r."finishedAt",
      r."retryOf",r."continuesRunId",r."threadReplacedBy",COALESCE(r."agentDefinition"->>'harness',a.harness) AS harness,CASE WHEN r."userId"=$2 THEN COALESCE(r."agentDefinition"->>'model',r."agentDefinition"->'subscription'->>'modelId',r."agentDefinition"->'apiKey'->>'model') ELSE NULL END AS "modelId",r."userId"=$2 AS owned
    FROM agent_runs r JOIN agents a ON a.id=r."agentId"
    LEFT JOIN bots b ON b.id=r."botId" LEFT JOIN computer_run_bindings cb ON cb."runId"=r.id
    WHERE r."issueId"=ANY($1::uuid[]) AND (b."workspaceId" IS NULL OR b."workspaceId"=$3)
      AND (cb."workspaceId" IS NULL OR cb."workspaceId"=$3)
    ORDER BY r."createdAt",r.id LIMIT $4`,
  `SELECT t.id,t.revision,t.status,t.stage,t."candidateId" FROM factory_tasks t LEFT JOIN bots b ON b.id=t."botId"
    WHERE t."issueId"=ANY($1::uuid[]) AND t."userId"=$2 AND (t."botId" IS NULL OR b."workspaceId"=$3) ORDER BY t.id LIMIT $4`,
  `SELECT c.id,c."taskId",t."issueId",c."runId",c.kind,c.sha,c."createdAt",
      EXISTS(SELECT 1 FROM factory_deliverable_acceptances a WHERE a."taskId"=c."taskId" AND a."candidateId"=c.id AND a."userId"=$2)
      OR EXISTS(SELECT 1 FROM factory_merges m WHERE m."taskId"=c."taskId" AND m."candidateId"=c.id AND m.status='merged') AS accepted
    FROM factory_candidates c JOIN factory_tasks t ON t.id=c."taskId"
    WHERE (SELECT allowed FROM initial_guard) AND t."issueId"=ANY($1::uuid[]) AND t."userId"=$2 AND c."runId"=ANY(ARRAY(SELECT id FROM projection_1 WHERE owned)) AND t.id=ANY(ARRAY(SELECT id FROM projection_2))
    ORDER BY c."createdAt",c.id LIMIT $4`,
  `SELECT a.id,a."taskId",t."issueId",a."candidateId",a."runId",a.stage,a.status,
      left(a.reason,4000) AS reason,a."createdAt",a."finishedAt"
    FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
    WHERE (SELECT allowed FROM initial_guard) AND t."issueId"=ANY($1::uuid[]) AND t."userId"=$2 AND a.stage IN ('review','verify')
      AND (a."runId" IS NULL OR a."runId"=ANY(ARRAY(SELECT id FROM projection_1 WHERE owned))) AND t.id=ANY(ARRAY(SELECT id FROM projection_2))
    ORDER BY a."createdAt",a.id LIMIT $4`,
  `SELECT a.id,v.id AS "versionId",v.version,a.kind,v."createdAt",
      left(COALESCE(NULLIF(e.payload->>'title',''),a.title),500) AS title,
      CASE WHEN e.id IS NULL THEN a."issueId" ELSE e."issueId" END AS "issueId",
      CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END AS "runId"
    FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
    LEFT JOIN coordinator_events e ON e."dedupeKey"='artifact_submitted:'||a.id::text||':'||v.version::text
    WHERE (SELECT allowed FROM initial_guard) AND a."userId"=$2
      AND ((e.id IS NULL AND v.version=1) OR (e.kind='artifact_submitted' AND e."userId"=a."userId"
        AND e.payload->>'artifactId'=a.id::text AND jsonb_typeof(e.payload->'version')='number' AND e.payload->>'version'=v.version::text))
      AND (CASE WHEN e.id IS NULL THEN a."issueId" ELSE e."issueId" END)=ANY($1::uuid[])
      AND ((CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END) IS NULL
        OR (CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END)=ANY(ARRAY(SELECT id FROM projection_1 WHERE owned)))
    ORDER BY v."createdAt",v.id LIMIT $4`,
  `SELECT "runId","issueId","remoteKey","pullRequest"->>'url' AS url
    FROM run_publications WHERE (SELECT allowed FROM initial_guard) AND "runId"=ANY(ARRAY(SELECT id FROM projection_1 WHERE owned)) AND "userId"=$2 ORDER BY "runId" LIMIT $4`,
  `SELECT id,"issueId","factoryTaskId","runId",kind,title,summary,reason,options,
      "selectedOptionId","contextOptionRef","predecessorDecisionIds",provenance,"captureMode","decidedBy","recordedBy",
      "occurredAt","recordedAt","supersedesId","recordStatus"
    FROM project_decisions WHERE (SELECT allowed FROM initial_guard) AND "projectId"=$7 AND "workspaceId"=$3 AND "ownerId"=$2
      AND ("issueId" IS NULL OR "issueId"=ANY($1::uuid[]))
      AND ("runId" IS NULL OR "runId"=ANY(ARRAY(SELECT id FROM projection_1 WHERE owned)))
      AND ("factoryTaskId" IS NULL OR "factoryTaskId"=ANY(ARRAY(SELECT id FROM projection_2)))
    ORDER BY "recordedAt",id LIMIT $4`,
  `SELECT id,"decisionId",role,"optionId",relation,locator
      FROM project_decision_sources WHERE (SELECT allowed FROM related_guard)
        AND "decisionId" IN (SELECT id FROM projection_7) AND "ownerId"=$2 AND "workspaceId"=$3 ORDER BY id LIMIT $5`,
  currentSourceAccessSql({
    sourceIds: 'ARRAY(SELECT id FROM projection_8 WHERE (SELECT allowed FROM source_guard))', userId: '$2', workspaceId: '$3',
    issueIds: '$1::uuid[]', ownRuns: 'ARRAY(SELECT id FROM projection_1 WHERE owned)', limit: String(MAP_SOURCE_LIMIT), personal: '$6',
  }),
]
const names = projections.map((_, index) => `projection_${index}`)
const size = (name: string) => `(SELECT bytes FROM ${name}_budget)`
const count = (name: string, max: number) => `(SELECT row_count FROM ${name}_budget) <= ${max}`
const stage = (indices: number[]) => indices.map(index => size(names[index])).join(' + ')
const first = [0, 1, 2], related = [3, 4, 5, 6, 7]

/** A single read-only statement gives every fact and source ACL one snapshot. */
export function mapFactsSql(compact = true) {
  const order = ['id', '"createdAt",id', 'id', '"createdAt",id', '"createdAt",id', '"createdAt","versionId"', '"runId"', '"recordedAt",id', 'id', 'id']
  return `WITH
    ${projections.map((projection, index) => {
      const guard = index === 3 ? `initial_guard AS MATERIALIZED (SELECT ${count(names[0], MAP_NODE_LIMIT)} AND ${count(names[1], MAP_NODE_LIMIT)}
        AND ${count(names[2], MAP_NODE_LIMIT)} AND ${stage(first)} <= $8 AS allowed),`
        : index === 8 ? `related_guard AS MATERIALIZED (SELECT (SELECT allowed FROM initial_guard)
          AND ${related.map(index => count(names[index], MAP_NODE_LIMIT)).join(' AND ')} AND ${stage([...first, ...related])} <= $8 AS allowed),`
        : index === 9 ? `source_guard AS MATERIALIZED (SELECT (SELECT allowed FROM related_guard)
          AND ${count(names[8], MAP_SOURCE_LIMIT)} AND ${stage([...first, ...related, 8])} <= $8 AS allowed),` : ''
      return `${guard}
${names[index]} AS MATERIALIZED (${projection}),
      ${names[index]}_budget AS MATERIALIZED (SELECT count(*) AS row_count,COALESCE(sum(octet_length(to_jsonb(${names[index]})::text)+2),0) AS bytes FROM ${names[index]})`
    }).join(',\n')},
    measured AS (SELECT ${stage(names.map((_, index) => index))} AS bytes)
    SELECT bytes,CASE WHEN bytes <= $8 AND (SELECT allowed FROM source_guard)
      THEN jsonb_build_array(${names.map((name, index) => compact && index < 2 ? compactMapRowsSql(name, index === 0 ? 'issues' : 'runs')
        : `COALESCE((SELECT jsonb_agg(to_jsonb(${name}) ORDER BY ${order[index]}) FROM ${name}),'[]'::jsonb)`).join(',')})
      ELSE NULL END AS rows FROM measured`
}
