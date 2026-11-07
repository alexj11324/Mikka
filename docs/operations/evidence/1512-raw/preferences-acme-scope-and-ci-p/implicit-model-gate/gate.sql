WITH target AS (
  SELECT b."ownerId", b."workspaceId", b.id
  FROM bots b
  JOIN coordinator_bots c
    ON c."botId" = b.id
   AND c."ownerId" = b."ownerId"
   AND c."workspaceId" = b."workspaceId"
  WHERE b.id = 'd51efc47-1c61-4758-8c05-fd7a07e3d7b2'::uuid
    AND b."workspaceId" = '4ae2a643-b09e-43eb-816c-1e5557bef170'::uuid
    AND b."archivedAt" IS NULL
), choice AS (
  SELECT m."bindingId" IS NOT NULL AS has_binding,
         m."apiKeyId" IS NOT NULL AS has_api_key,
         m."apiKeyModel" IS NOT NULL AND m."apiKeyModel" <> '' AS has_api_model
  FROM target t
  JOIN bot_model_choices m
    ON m."ownerId" = t."ownerId"
   AND m."workspaceId" = t."workspaceId"
   AND m."botKey" = t.id::text
)
SELECT
  (SELECT count(*)::int FROM target) AS target_scope_matches,
  (SELECT count(*)::int FROM choice) AS stored_choice_rows,
  CASE
    WHEN (SELECT count(*) FROM target) <> 1 THEN 'scope_unproven'
    WHEN (SELECT count(*) FROM choice) = 0 THEN 'implicit_default'
    WHEN (SELECT count(*) FROM choice) <> 1 THEN 'ambiguous'
    WHEN EXISTS (SELECT 1 FROM choice WHERE has_binding AND NOT has_api_key AND NOT has_api_model) THEN 'subscription'
    WHEN EXISTS (SELECT 1 FROM choice WHERE NOT has_binding AND has_api_key AND has_api_model) THEN 'api_key'
    WHEN EXISTS (SELECT 1 FROM choice WHERE NOT has_binding AND NOT has_api_key AND NOT has_api_model) THEN 'hosted'
    ELSE 'inconsistent'
  END AS persisted_choice_kind,
  EXISTS (SELECT 1 FROM choice WHERE has_binding) AS has_binding,
  EXISTS (SELECT 1 FROM choice WHERE has_api_key) AS has_api_key,
  EXISTS (SELECT 1 FROM choice WHERE has_api_model) AS has_api_model;
