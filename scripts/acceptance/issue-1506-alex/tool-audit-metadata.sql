-- Execute once AFTER the real tool terminal log, with the existing authorized
-- read-only database identity. No chat body, input, output, snapshot or call ID
-- is returned. The caller separately verifies deployment and supplies $5.
-- $1 = exact ACME owner; $2 = receipt Bot UUID; $3 = observed wrun:round;
-- $4 = receipt workspace UUID; $5 = independently verified application SHA.
WITH scoped AS (
  SELECT e.id, e.owner_id, e.bot_key, e.execution_key, e.status,
    e.finished_at, b."workspaceId" AS workspace_id,
    coalesce(e.snapshot->'effectiveTools' ? 'web_search', false) AS web_search_allowed
  FROM agent_kit_executions e
  JOIN bots b ON b.id::text = e.bot_key AND b."ownerId" = e.owner_id
  WHERE e.owner_id = $1 AND e.bot_key = $2 AND e.execution_key = $3
    AND b."workspaceId" = $4::uuid
)
SELECT jsonb_build_object(
  'schemaVersion', 1,
  'scope', jsonb_build_object(
    'applicationSha', $5::text,
    'ownerRef', left(encode(sha256(convert_to(s.owner_id, 'UTF8')), 'hex'), 12),
    'workspaceId', s.workspace_id, 'botId', s.bot_key,
    'workflowRunId', split_part(s.execution_key, ':', 1), 'streamId', s.execution_key
  ),
  'execution', jsonb_build_object(
    'id', s.id, 'executionKey', s.execution_key, 'status', s.status,
    'webSearchAllowed', s.web_search_allowed,
    'finishedAt', floor(extract(epoch FROM s.finished_at) * 1000)::bigint
  ),
  'auditReadAt', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint,
  'audit', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'kind', a.kind,
      'tool', CASE WHEN a.payload->>'toolName' = 'web_search' THEN 'web_search' ELSE 'unexpected' END,
      'callRef', left(encode(sha256(convert_to(regexp_replace(a.event_key, ':(start|finish)$', ''), 'UTF8')), 'hex'), 12),
      'outcome', CASE WHEN a.payload->>'outcome' IN ('ok', 'error', 'stopped', 'approval_pending') THEN a.payload->>'outcome' ELSE NULL END,
      'at', floor(extract(epoch FROM a.created_at) * 1000)::bigint
    ) ORDER BY a.created_at, a.event_key)
    FROM (
      SELECT kind, event_key, payload, created_at FROM agent_kit_events
      WHERE execution_id = s.id AND owner_id = s.owner_id AND bot_key = s.bot_key
        AND kind IN ('tool_started', 'tool_finished')
      ORDER BY created_at, event_key LIMIT 101
    ) a
  ), '[]'::jsonb),
  -- Insert only the fixed fields from exact-deployment runtime log records.
  'toolTimings', '[]'::jsonb,
  'stopTimings', '[]'::jsonb
) AS evidence
FROM scoped s;
