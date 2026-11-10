-- Per-worker run policies are retired too: a Bot (and the worker that runs it)
-- has no allow/ask/deny layer of its own. Fold every agents.cli_run_policy
-- deny/ask into each workspace the worker has actually run in, intersect its
-- network allow-list and carry read_only forward, then clear the worker
-- policy. Team and project scopes (cli_scope_policies) still narrow a task.
--
-- Only runs that already name a workspace participate; a worker with no run
-- has no workspace to restrict. The fold is idempotent: after the first run
-- the worker policies are empty and the workspace values are stable.
--
-- The network helpers come from 20261110230000_workspace_only_app_permissions.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE agents IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE agent_runs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE workspace_computer_policies IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  policy jsonb;
  context text;
  key text;
  value jsonb;
  item jsonb;
  domain_re constant text := '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$';
BEGIN
  FOR policy, context IN
    SELECT a.cli_run_policy, format('agents(%s)', a.id) FROM agents a
  LOOP
    IF jsonb_typeof(policy) <> 'object' THEN
      RAISE EXCEPTION 'workspace-only: % cli_run_policy is not an object', context;
    END IF;
    FOR key IN SELECT jsonb_object_keys(policy) LOOP
      IF key NOT IN ('permissions', 'networkAllow', 'approvalMode') THEN
        RAISE EXCEPTION 'workspace-only: % has unknown cli key %', context, key;
      END IF;
    END LOOP;
    IF policy ? 'permissions' THEN
      IF jsonb_typeof(policy->'permissions') <> 'object' THEN
        RAISE EXCEPTION 'workspace-only: % permissions is not an object', context;
      END IF;
      FOR key, value IN SELECT e.key, e.value FROM jsonb_each(policy->'permissions') e LOOP
        IF key NOT IN ('install_dependency', 'write_outside_repo', 'git_push', 'network') THEN
          RAISE EXCEPTION 'workspace-only: % stores unsupported cli action %', context, key;
        END IF;
        IF jsonb_typeof(value) <> 'string' OR (value #>> '{}') NOT IN ('allow', 'ask', 'deny') THEN
          RAISE EXCEPTION 'workspace-only: % stores invalid cli decision %=%', context, key, value;
        END IF;
      END LOOP;
    END IF;
    IF policy ? 'networkAllow' THEN
      IF jsonb_typeof(policy->'networkAllow') <> 'array' OR jsonb_array_length(policy->'networkAllow') > 200 THEN
        RAISE EXCEPTION 'workspace-only: % networkAllow is not a bounded array', context;
      END IF;
      FOR item IN SELECT * FROM jsonb_array_elements(policy->'networkAllow') LOOP
        IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ domain_re THEN
          RAISE EXCEPTION 'workspace-only: % stores invalid network domain %', context, item;
        END IF;
      END LOOP;
    END IF;
    IF policy ? 'approvalMode' AND (jsonb_typeof(policy->'approvalMode') <> 'string' OR (policy->>'approvalMode') NOT IN ('ask', 'read_only')) THEN
      RAISE EXCEPTION 'workspace-only: % stores invalid approval_mode', context;
    END IF;
  END LOOP;
END $$;

CREATE TEMP TABLE workspace_only_worker_sources ON COMMIT DROP AS
  SELECT DISTINCT r."workspaceId" AS workspace_id, a.id::text AS source_key, a.cli_run_policy AS policy
  FROM agents a
  JOIN agent_runs r ON r."agentId" = a.id
  WHERE r."workspaceId" IS NOT NULL AND a.cli_run_policy <> '{}'::jsonb;

CREATE TEMP TABLE workspace_only_worker_cli_sources ON COMMIT DROP AS
  SELECT workspace_id, 0 AS source_order, source_key, policy FROM workspace_only_worker_sources
  UNION ALL
  SELECT w."workspaceId", 1, '', w.cli_run_policy
  FROM workspace_computer_policies w;

CREATE TEMP TABLE workspace_only_worker_permissions ON COMMIT DROP AS
  SELECT workspace_id, jsonb_object_agg(action, to_jsonb(decision)) AS delta
  FROM (
    SELECT s.workspace_id, p.key AS action,
      CASE WHEN bool_or(p.value = 'deny') THEN 'deny' ELSE 'ask' END AS decision
    FROM workspace_only_worker_cli_sources s
    CROSS JOIN LATERAL jsonb_each_text(coalesce(s.policy->'permissions', '{}'::jsonb)) p
    WHERE p.value IN ('deny', 'ask')
      AND NOT (p.key = 'git_push' AND p.value = 'ask')
    GROUP BY s.workspace_id, p.key
  ) folded
  GROUP BY workspace_id;

CREATE TEMP TABLE workspace_only_worker_network ON COMMIT DROP AS
  SELECT workspace_id, mikka_intersect_network_lists(jsonb_agg(policy->'networkAllow' ORDER BY source_order, source_key)) AS network
  FROM workspace_only_worker_cli_sources
  WHERE policy ? 'networkAllow'
  GROUP BY workspace_id;

CREATE TEMP TABLE workspace_only_worker_read_only ON COMMIT DROP AS
  SELECT DISTINCT workspace_id
  FROM workspace_only_worker_cli_sources
  WHERE policy->>'approvalMode' = 'read_only';

CREATE TEMP TABLE workspace_only_worker_patch ON COMMIT DROP AS
  SELECT coalesce(p.workspace_id, n.workspace_id, r.workspace_id) AS workspace_id,
    jsonb_strip_nulls(jsonb_build_object(
      'permissions', p.delta,
      'networkAllow', n.network,
      'approvalMode', CASE WHEN r.workspace_id IS NOT NULL THEN 'read_only' END
    )) AS patch
  FROM workspace_only_worker_permissions p
  FULL JOIN workspace_only_worker_network n USING (workspace_id)
  FULL JOIN workspace_only_worker_read_only r USING (workspace_id);

UPDATE workspace_computer_policies w
SET cli_run_policy = jsonb_strip_nulls(jsonb_build_object(
  'permissions', CASE WHEN p.patch ? 'permissions'
    THEN coalesce(w.cli_run_policy->'permissions', '{}'::jsonb) || (p.patch->'permissions')
    ELSE w.cli_run_policy->'permissions' END,
  'networkAllow', CASE WHEN p.patch ? 'networkAllow'
    THEN p.patch->'networkAllow'
    ELSE w.cli_run_policy->'networkAllow' END,
  'approvalMode', CASE WHEN p.patch ? 'approvalMode'
    THEN p.patch->'approvalMode'
    ELSE w.cli_run_policy->'approvalMode' END,
  'defaults', w.cli_run_policy->'defaults'
))
FROM workspace_only_worker_patch p
WHERE w."workspaceId" = p.workspace_id
  AND w.cli_run_policy IS DISTINCT FROM jsonb_strip_nulls(jsonb_build_object(
    'permissions', CASE WHEN p.patch ? 'permissions'
      THEN coalesce(w.cli_run_policy->'permissions', '{}'::jsonb) || (p.patch->'permissions')
      ELSE w.cli_run_policy->'permissions' END,
    'networkAllow', CASE WHEN p.patch ? 'networkAllow'
      THEN p.patch->'networkAllow'
      ELSE w.cli_run_policy->'networkAllow' END,
    'approvalMode', CASE WHEN p.patch ? 'approvalMode'
      THEN p.patch->'approvalMode'
      ELSE w.cli_run_policy->'approvalMode' END,
    'defaults', w.cli_run_policy->'defaults'
  ));

INSERT INTO workspace_computer_policies ("workspaceId", permission, cli_run_policy)
SELECT p.workspace_id, 'allow', p.patch
FROM workspace_only_worker_patch p
WHERE p.patch <> '{}'::jsonb
  AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies w WHERE w."workspaceId" = p.workspace_id);

UPDATE agents SET cli_run_policy = '{}'::jsonb
WHERE cli_run_policy <> '{}'::jsonb;

COMMIT;
