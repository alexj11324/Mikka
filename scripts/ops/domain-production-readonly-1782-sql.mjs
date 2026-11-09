/** Fixed read-only projections. APP and WS have different connections. */
export const LEDGER = Object.freeze({
  app: [
    ['20261109035000_task_workspace_ownership.sql', '20261108120200_task_workspace_ownership.sql'],
    ['20261109143001_task_identity.sql', '20261108120301_task_identity.sql'],
    ['20261109143006_project_history_retention.sql', '20261108120306_project_history_retention.sql'],
    ['20261109143007_task_alias_tenant.sql', '20261108120307_task_alias_tenant.sql'],
  ],
  ws: [
    ['20261109143000_project_v2.sql', '20261108120300_project_v2.sql'],
    ['20261109143002_task_identity_aliases.sql', '20261108120302_task_identity_aliases.sql'],
    ['20261109143003_team_lifecycle.sql', '20261108120303_team_lifecycle.sql'],
    ['20261109143004_project_resources.sql', '20261108120304_project_resources.sql'],
    ['20261109143005_project_lifecycle.sql', '20261108120305_project_lifecycle.sql'],
    ['20261109143008_project_writer_fence.sql', '20261108120308_project_writer_fence.sql'],
  ],
})
export const REQUIRED_ZERO = Object.freeze({
  app: ['pendingWithoutRepair', 'boundWithoutIdentifier', 'issuedWithoutAlias', 'publishedWithoutAlias',
    'boundAliasWithoutTenant', 'conflictingAliasProjection', 'unknownOwnership', 'unknownRepair'],
  ws: ['boundWithoutReceipt', 'quarantineWithoutRepair', 'invalidProjectTaskRelation', 'duplicateTaskGroups', 'unknownRepair'],
})
export const COUNTERS = Object.freeze({
  app: ['bound', 'pending', 'unknownOwnership', 'missingEvidence', 'conflictingEvidence', 'missingWorkspace', 'unknownRepair',
    'pendingWithoutRepair', 'boundWithoutIdentifier', 'issuedWithoutAlias', 'publishedWithoutAlias',
    'boundAliasWithoutTenant', 'conflictingAliasProjection', 'unboundRuns', 'unboundFactory', 'unboundArtifacts',
    'publicationUnresolvedTask', 'publicationMismatchedRun', 'publicationUnresolvedRun', 'publicationConflictingWorkspace', 'publicationVerified'],
  ws: ['boundProjects', 'quarantinedProjects', 'missingEvidence', 'conflictingEvidence', 'missingWorkspace',
    'invalidTaskIds', 'conflictingTaskProjects', 'unresolvedTasks', 'unknownRepair', 'receipts',
    'boundWithoutReceipt', 'quarantineWithoutRepair', 'invalidProjectTaskRelation', 'duplicateTaskGroups'],
})
const appRepairReasons = "'missing_evidence','conflicting_evidence','missing_workspace'"
const wsRepairReasons = appRepairReasons + ",'invalid_task_ids','conflicting_task_projects','unresolved_tasks'"
const normalizedEnvironment = `jsonb_build_object(
  'runtime',coalesce(e.configuration->'runtime','"any"'::jsonb),
  'harness',coalesce(e.configuration->'harness','"any"'::jsonb),
  'variables',coalesce(e.configuration->'variables','{}'::jsonb),
  'secretIds',coalesce(e.configuration->'secretIds','[]'::jsonb),
  'repositoryKeys',coalesce(e.configuration->'repositoryKeys','[]'::jsonb))
  || CASE WHEN e.configuration ? 'setup' THEN jsonb_build_object('setup',e.configuration->'setup') ELSE '{}'::jsonb END`

export const SQL = Object.freeze({
  settings: `SELECT current_setting('transaction_read_only') AS readonly,
    current_setting('transaction_isolation') AS isolation`,
  ledger: `SELECT name, "appliedAt" AS "appliedAt" FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name`,
  ledgerDigest: `SELECT count(*)::text AS count, md5(coalesce(string_agg(name || '|' || "appliedAt"::text,chr(10) ORDER BY name),'')) AS digest FROM schema_migrations`,
  appCounts: `WITH publications AS (
    SELECT CASE WHEN i.id IS NULL OR i."ownershipState"<>'bound' THEN 'unresolved_task'
      WHEN r.id IS NULL OR r."issueId" IS DISTINCT FROM i.id OR r."userId" IS DISTINCT FROM p."userId" THEN 'mismatched_run'
      WHEN r."workspaceId" IS NULL THEN 'unresolved_run'
      WHEN r."workspaceId" IS DISTINCT FROM i."workspaceId" THEN 'conflicting_workspace' ELSE 'verified' END AS evidence
    FROM run_publications p LEFT JOIN issues i ON i.id=p."issueId" LEFT JOIN agent_runs r ON r.id=p."runId"
    WHERE p.identifier IS NOT NULL AND p.identifier<>''
  ) SELECT
    (SELECT count(*)::text FROM issues WHERE "ownershipState"='bound') AS bound,
    (SELECT count(*)::text FROM issues WHERE "ownershipState"='pending') AS pending,
    (SELECT count(*)::text FROM issues WHERE "ownershipState" IS NULL OR "ownershipState" NOT IN ('bound','pending')) AS "unknownOwnership",
    (SELECT count(*)::text FROM issue_workspace_repairs WHERE reason='missing_evidence') AS "missingEvidence",
    (SELECT count(*)::text FROM issue_workspace_repairs WHERE reason='conflicting_evidence') AS "conflictingEvidence",
    (SELECT count(*)::text FROM issue_workspace_repairs WHERE reason='missing_workspace') AS "missingWorkspace",
    (SELECT count(*)::text FROM issue_workspace_repairs WHERE reason IS NULL OR reason NOT IN (${appRepairReasons})) AS "unknownRepair",
    (SELECT md5(coalesce(string_agg(DISTINCT coalesce(reason,'<null>'),chr(10) ORDER BY coalesce(reason,'<null>')),'')) FROM issue_workspace_repairs WHERE reason IS NULL OR reason NOT IN (${appRepairReasons})) AS "unknownRepairDigest",
    (SELECT count(*)::text FROM issues i WHERE i."ownershipState"='pending' AND NOT EXISTS (SELECT 1 FROM issue_workspace_repairs r WHERE r."issueId"=i.id)) AS "pendingWithoutRepair",
    (SELECT count(*)::text FROM issues WHERE "ownershipState"='bound' AND "issuedIdentifier" IS NULL) AS "boundWithoutIdentifier",
    (SELECT count(*)::text FROM issues i WHERE i."ownershipState"='bound' AND i."issuedIdentifier" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id AND a.identifier=i."issuedIdentifier" AND a."ownerId"=i."userId" AND a."workspaceId"=i."workspaceId")) AS "issuedWithoutAlias",
    (SELECT count(*)::text FROM run_publications p JOIN issues i ON i.id=p."issueId" AND i."ownershipState"='bound'
      JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=i.id AND r."userId"=p."userId" AND r."workspaceId"=i."workspaceId"
      WHERE p.identifier IS NOT NULL AND p.identifier<>'' AND NOT EXISTS (
        SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id AND a.identifier=p.identifier AND a."ownerId"=i."userId" AND a."workspaceId"=i."workspaceId")) AS "publishedWithoutAlias",
    (SELECT count(*)::text FROM task_identifier_aliases a JOIN issues i ON i.id=a."issueId" AND i."userId"=a."ownerId" AND i."ownershipState"='bound' WHERE a."workspaceId" IS NULL) AS "boundAliasWithoutTenant",
    (SELECT count(*)::text FROM task_identifier_aliases a JOIN issues i ON i.id=a."issueId" WHERE a."ownerId" IS DISTINCT FROM i."userId" OR (a."workspaceId" IS NOT NULL AND a."workspaceId" IS DISTINCT FROM i."workspaceId")) AS "conflictingAliasProjection",
    (SELECT count(*)::text FROM agent_runs WHERE "workspaceId" IS NULL) AS "unboundRuns",
    (SELECT count(*)::text FROM factory_tasks WHERE "workspaceId" IS NULL) AS "unboundFactory",
    (SELECT count(*)::text FROM artifacts WHERE "workspaceId" IS NULL) AS "unboundArtifacts",
    (SELECT count(*)::text FROM publications WHERE evidence='unresolved_task') AS "publicationUnresolvedTask",
    (SELECT count(*)::text FROM publications WHERE evidence='mismatched_run') AS "publicationMismatchedRun",
    (SELECT count(*)::text FROM publications WHERE evidence='unresolved_run') AS "publicationUnresolvedRun",
    (SELECT count(*)::text FROM publications WHERE evidence='conflicting_workspace') AS "publicationConflictingWorkspace",
    (SELECT count(*)::text FROM publications WHERE evidence='verified') AS "publicationVerified"`,
  wsCounts: `SELECT
    (SELECT count(*)::text FROM workspace_projects WHERE "workspaceId" IS NOT NULL) AS "boundProjects",
    (SELECT count(*)::text FROM workspace_projects WHERE "workspaceId" IS NULL) AS "quarantinedProjects",
    (SELECT count(*)::text FROM workspace_project_repairs WHERE reason='missing_evidence') AS "missingEvidence",
    (SELECT count(*)::text FROM workspace_project_repairs WHERE reason='conflicting_evidence') AS "conflictingEvidence",
    (SELECT count(*)::text FROM workspace_project_repairs WHERE reason='missing_workspace') AS "missingWorkspace",
    (SELECT count(*)::text FROM workspace_project_repairs WHERE reason='invalid_task_ids') AS "invalidTaskIds",
    (SELECT count(*)::text FROM workspace_project_repairs WHERE reason='conflicting_task_projects') AS "conflictingTaskProjects",
    (SELECT count(*)::text FROM workspace_project_repairs WHERE reason='unresolved_tasks') AS "unresolvedTasks",
    (SELECT count(*)::text FROM workspace_project_repairs WHERE reason IS NULL OR reason NOT IN (${wsRepairReasons})) AS "unknownRepair",
    (SELECT md5(coalesce(string_agg(DISTINCT coalesce(reason,'<null>'),chr(10) ORDER BY coalesce(reason,'<null>')),'')) FROM workspace_project_repairs WHERE reason IS NULL OR reason NOT IN (${wsRepairReasons})) AS "unknownRepairDigest",
    (SELECT count(*)::text FROM workspace_project_v2_migrations) AS receipts,
    (SELECT count(*)::text FROM workspace_projects p WHERE p."workspaceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_project_v2_migrations m WHERE m."projectId"=p.id)) AS "boundWithoutReceipt",
    (SELECT count(*)::text FROM workspace_projects p WHERE p."workspaceId" IS NULL AND NOT EXISTS (SELECT 1 FROM workspace_project_repairs r WHERE r."projectId"=p.id)) AS "quarantineWithoutRepair",
    (SELECT count(*)::text FROM workspace_project_tasks t LEFT JOIN workspace_projects p ON p.id=t."projectId" WHERE p.id IS NULL OR p."workspaceId" IS DISTINCT FROM t."workspaceId") AS "invalidProjectTaskRelation",
    (SELECT count(*)::text FROM (SELECT "issueId" FROM workspace_project_tasks GROUP BY "issueId" HAVING count(*)>1) duplicates) AS "duplicateTaskGroups"`,
  appTasks: `SELECT id, "workspaceId"=$2::uuid AS tenant, "userId"=$3 AS owner,
    "ownershipState"='bound' AS bound, "issuedIdentifier" IS NOT NULL AS identified,
    md5(coalesce("issuedIdentifier",'')) AS "identifierDigest" FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id`,
  appRuns: `WITH selected AS (SELECT *, "agentDefinition"->'projectExecution' AS pe FROM agent_runs WHERE id=ANY($1::uuid[]))
    SELECT id, "issueId" AS "issueId", "workspaceId"=$2::uuid AS tenant, "userId"=$3 AS owner,
      status IN ('succeeded','completed','failed','stopped','cancelled') AS ended,
      status IN ('succeeded','completed') AS succeeded,
      jsonb_typeof(pe)='object' AND pe->>'version'='1' AS structured,
      pe->>'workspaceId'=$2::text AS "snapshotTenant", pe->>'projectId'=$4::text AS "snapshotProject",
      pe->>'repositoryKey'=$5::text AS "snapshotRepository", (pe->>'baseBranch' IS NOT DISTINCT FROM $6::text)
        AND "baseBranch" IS NOT DISTINCT FROM $6::text AS "snapshotBranch",
      pe->'environment'->>'id'=$7::text AS "snapshotEnvironment",
      pe->'environment'->>'runtime'=$8::text AS "snapshotRuntime", pe->'environment'->>'harness'=$9::text AS "snapshotHarness",
      pe->>'projectRevision' AS "projectRevision", pe->>'policyRevision' AS "policyRevision",
      pe->'environment'->>'revision' AS "environmentRevision",
      jsonb_typeof(pe->'environment')='object' AND jsonb_typeof(pe->'environment'->'variables')='object'
        AND jsonb_typeof(pe->'environment'->'secretIds')='array' AND jsonb_typeof(pe->'environment'->'repositoryKeys')='array'
        AND pe->'environment'->>'runtime' IN ('any','cloud')
        AND pe->'environment'->>'harness' IN ('any','claude_code','codex','cursor') AS "environmentStructure",
      md5(((pe->'environment')-'id'-'name'-'revision')::text) AS "environmentDigest",
      md5(pe::text) AS "projectExecutionDigest",
      md5(jsonb_build_object('agentDefinition',"agentDefinition",'baseBranch',"baseBranch")::text) AS "frozenDigest"
    FROM selected ORDER BY id`,
  wsMembership: `SELECT count(*)::text AS count FROM mikka_workspace_members m JOIN mikka_workspaces w ON w.id=m."workspaceId"
    WHERE w.id=$1::uuid AND m."userId"=$2 AND m.status='active' AND m.role IN ('member','admin') AND w.kind='team'`,
  wsLinks: `SELECT "issueId" AS "issueId", "projectId"=$2::uuid AS project, "workspaceId"=$3::uuid AS tenant
    FROM workspace_project_tasks WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"`,
  wsResource: `SELECT p.id, p."workspaceId"=$2::uuid AS tenant, p."archivedAt" IS NULL AS active,
    p.revision AS "projectRevision", e.revision AS "environmentRevision", coalesce(w.revision,0) AS "policyRevision",
    r."baseBranch" IS NOT DISTINCT FROM $4 AS branch,
    coalesce(r."environmentId",(SELECT "environmentId" FROM workspace_project_environments WHERE "projectId"=p.id AND "workspaceId"=$2::uuid AND "isDefault"))=$3::uuid AS environment,
    EXISTS (SELECT 1 FROM workspace_project_environments b WHERE b."projectId"=p.id AND b."workspaceId"=$2::uuid AND b."environmentId"=$3::uuid) AS linked,
    e."workspaceId"=$2::uuid AND e."archivedAt" IS NULL AS "environmentActive",
    coalesce(w.mode,'inherit')='inherit' OR (w.mode='restricted' AND w."repositoryKeys" ? $5) AS "policyAllowed",
    jsonb_typeof(e.configuration)='object' AND coalesce(e.configuration->>'runtime','any') IN ('any','cloud')
      AND coalesce(e.configuration->>'harness','any') IN ('any','claude_code','codex','cursor') AS "environmentStructure",
    md5((${normalizedEnvironment})::text) AS "environmentDigest"
    FROM workspace_projects p JOIN workspace_project_repositories r ON r."projectId"=p.id AND r."workspaceId"=$2::uuid AND r."repositoryKey"=$5
    JOIN workspace_environments e ON e.id=$3::uuid
    LEFT JOIN workspace_repository_policies w ON w."workspaceId"=$2::uuid
    WHERE p.id=$1::uuid`,
})
