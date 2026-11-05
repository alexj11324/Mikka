-- Decision 2026-11-05-0400: 优先使用的 Agent now picks which Agent's list 优先使用的模型 shows and dispatch tries
-- first. Everyone keeps their current first choice: a saved list's 优先使用的 Agent becomes the Agent of its first
-- row. Untouched lists (customized = false) keep theirs; running this again changes nothing more.
UPDATE model_order_settings s
SET "preferredHarness" = first.harness, "updatedAt" = now()
FROM (
  SELECT DISTINCT ON ("ownerId", "workspaceId") "ownerId", "workspaceId", harness
  FROM model_order_entries
  ORDER BY "ownerId", "workspaceId", position
) AS first
WHERE s."ownerId" = first."ownerId" AND s."workspaceId" = first."workspaceId"
  AND s.customized AND s."preferredHarness" <> first.harness AND first.harness IN ('claude_code', 'codex');
