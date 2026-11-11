-- Workspace is the only app-permission surface (ADR 2026-11-10-1730).
--
-- Fold every per-Bot deny/ask from agent_kit_heads.external_write_permissions
-- and cli_run_policy into the workspace policy, then clear the workspace-linked
-- heads. An allow is never copied: copying a Bot's allow would grant it to
-- every other Bot in the workspace, while dropping it can only fall back to
-- the Decision API default. The fold is idempotent.
--
-- The legacy owner-scoped Coordinator head (workspace_id and bot_id null) is
-- folded into each of its coordinator_bots workspaces but is not cleared here:
-- a rolling deploy still reads it for its botless branch. A later version
-- removes that ceiling after the personal-workspace backfill.
--
-- browser_<effect>: ask is dropped from a Bot row (the runtime reads it as
-- allow and settings reject it); if a workspace row already stores one the
-- migration aborts, because that policy cannot be read back.
-- github_pull_request is not folded: no gate reads it any more and the plugin
-- route is retired, so mapping it to `github: deny` would widen it to every
-- GitHub call. git_push: ask was normalized to allow earlier and is skipped.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE agent_kit_heads IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE workspace_computer_policies IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE coordinator_bots IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- Preflight: malformed stored policies abort instead of being guessed at.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad record;
  policy jsonb;
  context text;
  key text;
  value jsonb;
  item jsonb;
  domain_re constant text := '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$';
BEGIN
  -- external_write_permissions: object, valid keys and decisions.
  SELECT h.owner_id, h.bot_key INTO bad
  FROM agent_kit_heads h
  WHERE jsonb_typeof(h.external_write_permissions) <> 'object'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'workspace-only: agent_kit_heads(%,%) external_write_permissions is not an object', bad.owner_id, bad.bot_key;
  END IF;

  SELECT h.owner_id, h.bot_key, e.key, e.value INTO bad
  FROM agent_kit_heads h
  CROSS JOIN LATERAL jsonb_each_text(h.external_write_permissions) e
  WHERE e.value IS NULL OR e.key !~ '^[a-z][a-z0-9_]{0,63}$' OR e.value NOT IN ('allow', 'ask', 'deny')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'workspace-only: agent_kit_heads(%,%) stores invalid external setting %=%', bad.owner_id, bad.bot_key, bad.key, bad.value;
  END IF;

  SELECT w."workspaceId" INTO bad
  FROM workspace_computer_policies w
  WHERE jsonb_typeof(w.external_write_permissions) <> 'object'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'workspace-only: workspace % external_write_permissions is not an object', bad."workspaceId";
  END IF;

  SELECT w."workspaceId", e.key, e.value INTO bad
  FROM workspace_computer_policies w
  CROSS JOIN LATERAL jsonb_each_text(w.external_write_permissions) e
  WHERE e.value IS NULL OR e.key !~ '^[a-z][a-z0-9_]{0,63}$' OR e.value NOT IN ('allow', 'ask', 'deny')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'workspace-only: workspace % stores invalid external setting %=%', bad."workspaceId", bad.key, bad.value;
  END IF;

  SELECT w."workspaceId" INTO bad
  FROM workspace_computer_policies w
  CROSS JOIN LATERAL jsonb_each_text(w.external_write_permissions) e
  WHERE e.key LIKE 'browser\_%' AND e.value = 'ask'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'workspace-only: workspace % stores browser ask, which is not a browser option', bad."workspaceId";
  END IF;

  -- cli_run_policy: strict keys, no computer_use, valid domains and mode.
  FOR policy, context IN
    SELECT h.cli_run_policy, format('agent_kit_heads(%s,%s)', h.owner_id, h.bot_key) FROM agent_kit_heads h
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

  FOR policy, context IN
    SELECT w.cli_run_policy, format('workspace %s', w."workspaceId") FROM workspace_computer_policies w
  LOOP
    IF jsonb_typeof(policy) <> 'object' THEN
      RAISE EXCEPTION 'workspace-only: % cli_run_policy is not an object', context;
    END IF;
    FOR key IN SELECT jsonb_object_keys(policy) LOOP
      IF key NOT IN ('permissions', 'networkAllow', 'approvalMode', 'defaults') THEN
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
    IF policy ? 'defaults' THEN
      IF jsonb_typeof(policy->'defaults') <> 'object' THEN
        RAISE EXCEPTION 'workspace-only: % defaults is not an object', context;
      END IF;
      FOR key IN SELECT jsonb_object_keys(policy->'defaults') LOOP
        IF key NOT IN ('permissions', 'networkAllow', 'approvalMode') THEN
          RAISE EXCEPTION 'workspace-only: % defaults has unknown key %', context, key;
        END IF;
      END LOOP;
      IF policy->'defaults' ? 'permissions' THEN
        IF jsonb_typeof(policy->'defaults'->'permissions') <> 'object' THEN
          RAISE EXCEPTION 'workspace-only: % defaults permissions is not an object', context;
        END IF;
        FOR key, value IN SELECT e.key, e.value FROM jsonb_each(policy->'defaults'->'permissions') e LOOP
          IF key NOT IN ('install_dependency', 'write_outside_repo', 'git_push', 'network') THEN
            RAISE EXCEPTION 'workspace-only: % defaults stores unsupported cli action %', context, key;
          END IF;
          IF jsonb_typeof(value) <> 'string' OR (value #>> '{}') NOT IN ('allow', 'ask', 'deny') THEN
            RAISE EXCEPTION 'workspace-only: % defaults stores invalid cli decision %=%', context, key, value;
          END IF;
        END LOOP;
      END IF;
      IF policy->'defaults' ? 'networkAllow' THEN
        IF jsonb_typeof(policy->'defaults'->'networkAllow') <> 'array' OR jsonb_array_length(policy->'defaults'->'networkAllow') > 200 THEN
          RAISE EXCEPTION 'workspace-only: % defaults networkAllow is not a bounded array', context;
        END IF;
        FOR item IN SELECT * FROM jsonb_array_elements(policy->'defaults'->'networkAllow') LOOP
          IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ domain_re THEN
            RAISE EXCEPTION 'workspace-only: % defaults stores invalid network domain %', context, item;
          END IF;
        END LOOP;
      END IF;
      IF policy->'defaults' ? 'approvalMode' AND (jsonb_typeof(policy->'defaults'->'approvalMode') <> 'string' OR (policy->'defaults'->>'approvalMode') NOT IN ('ask', 'read_only')) THEN
        RAISE EXCEPTION 'workspace-only: % defaults stores invalid approval_mode', context;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- external_write_permissions: restrictive fold, then clear workspace heads.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE workspace_only_external_sources ON COMMIT DROP AS
  SELECT h.workspace_id, e.key, e.value
  FROM agent_kit_heads h
  CROSS JOIN LATERAL jsonb_each_text(h.external_write_permissions) e
  WHERE h.workspace_id IS NOT NULL
  UNION ALL
  SELECT cb."workspaceId", e.key, e.value
  FROM agent_kit_heads h
  JOIN coordinator_bots cb ON cb."ownerId" = h.owner_id
  CROSS JOIN LATERAL jsonb_each_text(h.external_write_permissions) e
  WHERE h.workspace_id IS NULL AND h.bot_id IS NULL AND h.bot_key = 'coordinator'
  UNION ALL
  SELECT w."workspaceId", e.key, e.value
  FROM workspace_computer_policies w
  CROSS JOIN LATERAL jsonb_each_text(w.external_write_permissions) e;

DO $$
DECLARE
  bad record;
BEGIN
  SELECT workspace_id, count(DISTINCT key) AS keys INTO bad
  FROM workspace_only_external_sources
  GROUP BY workspace_id
  HAVING count(DISTINCT key) > 100
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'workspace-only: workspace % would hold % external keys; the limit is 100', bad.workspace_id, bad.keys;
  END IF;
END $$;

CREATE TEMP TABLE workspace_only_external_delta ON COMMIT DROP AS
  SELECT workspace_id, jsonb_object_agg(key, to_jsonb(decision)) AS delta
  FROM (
    SELECT workspace_id, key,
      CASE WHEN bool_or(value = 'deny') THEN 'deny' ELSE 'ask' END AS decision
    FROM workspace_only_external_sources
    WHERE value IN ('deny', 'ask')
      AND NOT (key LIKE 'browser\_%' AND value = 'ask')
      AND key <> 'github_pull_request'
      AND NOT (key = 'git_push' AND value = 'ask')
    GROUP BY workspace_id, key
  ) folded
  GROUP BY workspace_id;

INSERT INTO workspace_computer_policies
  ("workspaceId", permission, external_write_permissions, external_write_policy_version)
SELECT workspace_id, 'allow', delta, CASE WHEN delta = '{}'::jsonb THEN 0 ELSE 1 END
FROM workspace_only_external_delta
ON CONFLICT ("workspaceId") DO UPDATE
SET external_write_permissions =
  workspace_computer_policies.external_write_permissions || excluded.external_write_permissions
WHERE workspace_computer_policies.external_write_permissions IS DISTINCT FROM
      workspace_computer_policies.external_write_permissions || excluded.external_write_permissions;

UPDATE agent_kit_heads SET external_write_permissions = '{}'::jsonb
WHERE workspace_id IS NOT NULL AND external_write_permissions <> '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- cli_run_policy: restrictive fold for permissions, intersection for the
-- network allow-list, read_only wins; then clear workspace heads.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mikka_network_domain_parts(value text)
RETURNS TABLE (host text, port text, wildcard boolean) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  match text[];
BEGIN
  IF value = '*' THEN
    host := '*'; port := NULL; wildcard := false; RETURN NEXT; RETURN;
  END IF;
  match := regexp_match(lower(value), '^(\*\.)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$');
  IF match IS NULL THEN RETURN; END IF;
  host := match[2]; port := match[3]; wildcard := match[1] IS NOT NULL;
  IF port IS NOT NULL AND port::int > 65535 THEN
    host := NULL; port := NULL; RETURN NEXT; RETURN;
  END IF;
  IF position('..' IN host) > 0 THEN host := NULL; port := NULL; END IF;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION mikka_network_includes(outer_host text, outer_wildcard boolean, inner_host text, inner_wildcard boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN outer_host = '*' THEN true
    WHEN inner_host = '*' THEN false
    WHEN NOT outer_wildcard THEN (NOT inner_wildcard AND outer_host = inner_host)
    ELSE (inner_host LIKE '%.' || outer_host OR (inner_wildcard AND inner_host = outer_host))
  END
$$;

CREATE OR REPLACE FUNCTION mikka_intersect_network_domains(left_domains text[], right_domains text[])
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  left_domain text; right_domain text;
  left_parts record; right_parts record;
  narrow_host text; narrow_wildcard boolean; use_port text; candidate text;
  result text[] := '{}';
BEGIN
  IF left_domains IS NULL THEN RETURN right_domains; END IF;
  IF right_domains IS NULL THEN RETURN left_domains; END IF;
  FOREACH left_domain IN ARRAY left_domains LOOP
    FOREACH right_domain IN ARRAY right_domains LOOP
      SELECT * INTO left_parts FROM mikka_network_domain_parts(left_domain);
      SELECT * INTO right_parts FROM mikka_network_domain_parts(right_domain);
      IF left_parts.host IS NULL OR right_parts.host IS NULL THEN CONTINUE; END IF;
      IF left_parts.port IS NOT NULL AND right_parts.port IS NOT NULL AND left_parts.port <> right_parts.port THEN CONTINUE; END IF;
      IF mikka_network_includes(left_parts.host, left_parts.wildcard, right_parts.host, right_parts.wildcard) THEN
        narrow_host := right_parts.host; narrow_wildcard := right_parts.wildcard;
      ELSIF mikka_network_includes(right_parts.host, right_parts.wildcard, left_parts.host, left_parts.wildcard) THEN
        narrow_host := left_parts.host; narrow_wildcard := left_parts.wildcard;
      ELSE
        CONTINUE;
      END IF;
      use_port := coalesce(left_parts.port, right_parts.port);
      candidate := (CASE WHEN narrow_wildcard THEN '*.' ELSE '' END) || narrow_host || coalesce(':' || use_port, '');
      IF NOT (candidate = ANY(result)) THEN result := array_append(result, candidate); END IF;
    END LOOP;
  END LOOP;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION mikka_intersect_network_lists(lists jsonb)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  current jsonb; domains text[]; result text[];
BEGIN
  FOR current IN SELECT * FROM jsonb_array_elements(lists) LOOP
    SELECT coalesce(array_agg(value), '{}'::text[]) INTO domains FROM jsonb_array_elements_text(current) AS t(value);
    IF result IS NULL THEN result := domains;
    ELSE result := mikka_intersect_network_domains(result, domains);
    END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE TEMP TABLE workspace_only_cli_sources ON COMMIT DROP AS
  SELECT h.workspace_id, 0 AS source_order, h.bot_key AS source_key, h.cli_run_policy AS policy
  FROM agent_kit_heads h
  WHERE h.workspace_id IS NOT NULL
  UNION ALL
  SELECT cb."workspaceId", 1, h.bot_key, h.cli_run_policy
  FROM agent_kit_heads h
  JOIN coordinator_bots cb ON cb."ownerId" = h.owner_id
  WHERE h.workspace_id IS NULL AND h.bot_id IS NULL AND h.bot_key = 'coordinator'
  UNION ALL
  SELECT w."workspaceId", 2, '', w.cli_run_policy
  FROM workspace_computer_policies w;

CREATE TEMP TABLE workspace_only_cli_permissions ON COMMIT DROP AS
  SELECT workspace_id, jsonb_object_agg(action, to_jsonb(decision)) AS delta
  FROM (
    SELECT s.workspace_id, p.key AS action,
      CASE WHEN bool_or(p.value = 'deny') THEN 'deny' ELSE 'ask' END AS decision
    FROM workspace_only_cli_sources s
    CROSS JOIN LATERAL jsonb_each_text(coalesce(s.policy->'permissions', '{}'::jsonb)) p
    WHERE p.value IN ('deny', 'ask')
      AND NOT (p.key = 'git_push' AND p.value = 'ask')
    GROUP BY s.workspace_id, p.key
  ) folded
  GROUP BY workspace_id;

CREATE TEMP TABLE workspace_only_cli_network ON COMMIT DROP AS
  SELECT workspace_id, mikka_intersect_network_lists(jsonb_agg(policy->'networkAllow' ORDER BY source_order, source_key)) AS network
  FROM workspace_only_cli_sources
  WHERE policy ? 'networkAllow'
  GROUP BY workspace_id;

CREATE TEMP TABLE workspace_only_cli_read_only ON COMMIT DROP AS
  SELECT DISTINCT workspace_id
  FROM workspace_only_cli_sources
  WHERE policy->>'approvalMode' = 'read_only';

CREATE TEMP TABLE workspace_only_cli_patch ON COMMIT DROP AS
  SELECT coalesce(p.workspace_id, n.workspace_id, r.workspace_id) AS workspace_id,
    jsonb_strip_nulls(jsonb_build_object(
      'permissions', p.delta,
      'networkAllow', n.network,
      'approvalMode', CASE WHEN r.workspace_id IS NOT NULL THEN 'read_only' END
    )) AS patch
  FROM workspace_only_cli_permissions p
  FULL JOIN workspace_only_cli_network n USING (workspace_id)
  FULL JOIN workspace_only_cli_read_only r USING (workspace_id);

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
FROM workspace_only_cli_patch p
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
FROM workspace_only_cli_patch p
WHERE p.patch <> '{}'::jsonb
  AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies w WHERE w."workspaceId" = p.workspace_id);

UPDATE agent_kit_heads SET cli_run_policy = '{}'::jsonb
WHERE workspace_id IS NOT NULL AND cli_run_policy <> '{}'::jsonb;

COMMIT;
