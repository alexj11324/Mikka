SELECT jsonb_build_object(
 'deviceId',d.id,'removedAt',d."removedAt",'enabled',d.enabled,
 'activeRuns',(SELECT count(*) FROM agent_runs r WHERE r."deviceId"=d.id AND r."userId"=d."ownerId" AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')),
 'activeBoundTokens',(SELECT count(*) FROM device_tokens t WHERE t."boundDeviceId"=d.id AND t."userId"=d."ownerId" AND t."revokedAt" IS NULL AND (t."expiresAt" IS NULL OR t."expiresAt">now())),
 'activeAssociatedTokens',(SELECT count(*) FROM device_token_devices x JOIN device_tokens t ON t.id=x."tokenId" WHERE x."deviceId"=d.id AND x."userId"=d."ownerId" AND t."revokedAt" IS NULL AND (t."expiresAt" IS NULL OR t."expiresAt">now())),
 'asOf',now()
) AS cleanup FROM devices d WHERE d.id='66139361-5785-48f6-be1f-1dcf3300535c'::uuid;
