ALTER TABLE execution_rules ALTER COLUMN label DROP NOT NULL;
ALTER TABLE execution_rules ALTER COLUMN place DROP DEFAULT;
ALTER TABLE execution_rules ALTER COLUMN harness DROP DEFAULT;
ALTER TABLE execution_rules ALTER COLUMN model DROP DEFAULT;
CREATE UNIQUE INDEX IF NOT EXISTS execution_rules_default_idx ON execution_rules ("ownerId","workspaceId") WHERE label IS NULL;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "executionFallbacks" jsonb NOT NULL DEFAULT '{"whenDeviceOffline":"wait","whenQuotaExhausted":"stop"}';
-- Resolve legacy rows using existing owner reports. Missing discovery metadata is
-- retried under the scope lock on first settings read/dispatch, never guessed.
WITH choices AS (
 SELECT r.id,
   CASE WHEN r.place='auto' THEN coalesce(d.id::text,'cloud') ELSE r.place END AS place,
   CASE WHEN r.harness='auto' THEN coalesce(d.info->>'harness',CASE b.provider WHEN 'claude' THEN 'claude_code' WHEN 'codex' THEN 'codex' END) ELSE r.harness END AS harness,
   CASE WHEN r.model='auto' THEN coalesce(d.info->>'defaultModelSlot',d.info->'models'->>0,b."modelId") ELSE r.model END AS model
 FROM execution_rules r
 LEFT JOIN LATERAL (
   SELECT dev.id,h.info FROM devices dev CROSS JOIN LATERAL jsonb_array_elements(coalesce(dev.harnesses,'[]'::jsonb)) WITH ORDINALITY h(info,ordinal)
   WHERE dev."ownerId"=r."ownerId" AND dev.kind='local' AND dev."removedAt" IS NULL
   AND ((r.place='auto' AND dev.enabled AND dev."lastSeenAt">=now()-interval '60 seconds') OR dev.id::text=r.place)
   AND h.info->>'installed'='true' AND h.info->>'harness' IN ('claude_code','codex','cursor')
   AND (r.harness='auto' OR h.info->>'harness'=r.harness)
   ORDER BY dev."lastSeenAt" DESC NULLS LAST,dev.id,h.ordinal LIMIT 1
 ) d ON true
 LEFT JOIN LATERAL (
   SELECT binding."modelId",c.provider FROM byos_bindings binding
   JOIN byos_connections c ON c.id=binding."connectionId" AND c."ownerId"=binding."ownerId" AND c."workspaceId"=binding."workspaceId" AND c.epoch=binding."connectionRevision" AND c.state='connected'
   WHERE binding."ownerId"=r."ownerId" AND binding."workspaceId"=r."workspaceId"::text
   AND binding.route IN ('claude_cpa','codex_cpa','openai_siwc')
   AND (coalesce(d.info->>'harness',nullif(r.harness,'auto')) IS NULL OR c.provider=CASE coalesce(d.info->>'harness',r.harness) WHEN 'claude_code' THEN 'claude' WHEN 'codex' THEN 'codex' END)
   ORDER BY binding."createdAt" DESC,binding.id LIMIT 1
 ) b ON true
 WHERE r.place='auto' OR r.harness='auto' OR r.model='auto'
)
UPDATE execution_rules r SET place=c.place,harness=c.harness,model=c.model FROM choices c
WHERE r.id=c.id AND c.place IS NOT NULL AND c.harness IS NOT NULL AND c.model IS NOT NULL
AND c.place<>'auto' AND c.harness<>'auto' AND c.model<>'auto';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='execution_rules'::regclass AND conname='execution_rules_explicit') THEN
 ALTER TABLE execution_rules ADD CONSTRAINT execution_rules_explicit CHECK (place <> 'auto' AND harness IN ('claude_code','codex','cursor') AND model <> 'auto' AND length(model)>0) NOT VALID;
 END IF;
END $$;
