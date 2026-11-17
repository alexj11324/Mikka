-- Decision 2026-11-17: a Claude or Codex subscription serves its owner only.
-- The sharing rows no longer grant anything; remove them, and clear Bot chat
-- choices that still name a teammate's subscription so the chat asks for its
-- own model instead of failing at run time.
DELETE FROM workspace_subscription_shares;
UPDATE bot_model_choices c SET "bindingId" = NULL
  FROM byos_bindings b
  WHERE b.id::text = c."bindingId"::text AND b."ownerId" <> c."ownerId";
