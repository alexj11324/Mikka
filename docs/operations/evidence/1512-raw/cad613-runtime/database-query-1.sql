WITH target AS (
  SELECT r.id, r."userId", r."issueId", r."deviceId", r.status, r.error, r."startedAt", r."finishedAt", d."removedAt"
  FROM agent_runs r JOIN devices d ON d.id = r."deviceId" AND d."ownerId" = r."userId"
  WHERE r.id = 'f879d6cd-bdbd-4e62-9a17-441f1f763a25'::uuid
    AND r."issueId" = '43486283-4731-4842-bce1-fa5f1e96b8f9'::uuid
    AND r."deviceId" = '09479c68-dcb4-4735-a91f-e355259c0eef'::uuid
    AND r."botId" = 'bc925088-d87f-47b8-a786-c1c317ac005f'::uuid
), patterns(code, pattern) AS (VALUES
  ('subscription_auth_unavailable', 'Codex subscription authentication unavailable'),
  ('invalid_auth', 'invalid.{0,20}(token|auth)|unauthorized|authentication|not authenticated'),
  ('forbidden', 'forbidden|permission denied'),
  ('usage_or_quota_limit', 'usage.{0,20}limit|quota|credit|billing|insufficient'),
  ('rate_limit', 'rate.{0,10}limit|too many requests'),
  ('model_unavailable', 'model.{0,40}(not found|unavailable|unsupported|not supported)|unsupported.{0,20}model'),
  ('network', 'network|ECONN|ENOTFOUND|fetch failed|connection|TLS|certificate'),
  ('timeout', 'timed out|timeout'),
  ('app_server_exit', 'app-server exited'),
  ('thread_or_session', 'thread|session'),
  ('worktree_or_repository', 'worktree|repository'),
  ('execution_identity', 'executionIdentityUnavailable'),
  ('tool_approval', 'Run tool approval unavailable')
)
SELECT jsonb_build_object(
  'runId', t.id,
  'status', CASE WHEN t.status IN ('queued','preparing','running','paused','waiting_input','finishing','succeeded','completed','failed','stopped','cancelled') THEN t.status ELSE 'unknown' END,
  'startedAt', t."startedAt", 'finishedAt', t."finishedAt",
  'errorPresent', t.error IS NOT NULL,
  'errorBytes', octet_length(t.error),
  'errorSha256', encode(sha256(convert_to(t.error,'UTF8')),'hex'),
  'errorPatternMatches', COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM patterns WHERE t.error ~* pattern), '[]'::jsonb),
  'deviceRemovedAt', t."removedAt",
  'activeDeviceRuns', (SELECT count(*) FROM agent_runs r WHERE r."deviceId" = t."deviceId" AND r."userId" = t."userId" AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')),
  'activeIssueRuns', (SELECT count(*) FROM agent_runs r WHERE r."issueId" = t."issueId" AND r."userId" = t."userId" AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')),
  'activeBoundDeviceTokens', (SELECT count(*) FROM device_tokens dt WHERE dt."boundDeviceId" = t."deviceId" AND dt."userId" = t."userId" AND dt."revokedAt" IS NULL AND (dt."expiresAt" IS NULL OR dt."expiresAt" > now())),
  'activeAssociatedDeviceTokens', (SELECT count(*) FROM device_token_devices dtd JOIN device_tokens dt ON dt.id=dtd."tokenId" WHERE dtd."deviceId"=t."deviceId" AND dtd."userId"=t."userId" AND dt."revokedAt" IS NULL AND (dt."expiresAt" IS NULL OR dt."expiresAt">now())),
  'chunkTypes', (SELECT COALESCE(jsonb_object_agg(kind,n),'{}'::jsonb) FROM (
    SELECT CASE WHEN c.chunk->>'type' IN ('start','finish','start-step','finish-step','abort','error','data-run-stage','text-start','text-delta','text-end','reasoning-start','reasoning-delta','reasoning-end','tool-input-start','tool-input-delta','tool-input-available','tool-input-error','tool-output-available','tool-output-error','tool-output-denied') THEN c.chunk->>'type' ELSE 'other' END AS kind, count(*) AS n
    FROM run_chunks c WHERE c."runId"=t.id GROUP BY 1
  ) q)
) AS diagnostic FROM target t;
