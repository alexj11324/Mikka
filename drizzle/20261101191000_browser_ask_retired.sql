-- Bots operate their browsers without asking (Alex, 2026-10-30); "ask" is not
-- a browser option (Alex, 2026-11-01: 「为什么会有询问这个选项？」). Every stored
-- browser_<effect>: "ask", on an agent head or a workspace policy, becomes
-- "allow"; "deny" and every non-browser action are untouched. The automatic
-- policy version moves, so a browser action pending on the old revision expires.
LOCK TABLE agent_kit_heads IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE workspace_computer_policies IN SHARE ROW EXCLUSIVE MODE;
UPDATE agent_kit_heads
SET external_write_permissions = (
  SELECT jsonb_object_agg(e.key, CASE WHEN e.key LIKE 'browser\_%' AND e.value = '"ask"'::jsonb THEN '"allow"'::jsonb ELSE e.value END)
  FROM jsonb_each(external_write_permissions) e
)
WHERE EXISTS (SELECT 1 FROM jsonb_each_text(external_write_permissions) e WHERE e.key LIKE 'browser\_%' AND e.value = 'ask');
UPDATE workspace_computer_policies
SET external_write_permissions = (
  SELECT jsonb_object_agg(e.key, CASE WHEN e.key LIKE 'browser\_%' AND e.value = '"ask"'::jsonb THEN '"allow"'::jsonb ELSE e.value END)
  FROM jsonb_each(external_write_permissions) e
)
WHERE EXISTS (SELECT 1 FROM jsonb_each_text(external_write_permissions) e WHERE e.key LIKE 'browser\_%' AND e.value = 'ask');
