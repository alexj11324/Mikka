-- target: MIKKA_DATABASE_URL
-- Settings › 审计日志 (N6, SEC-12～14). Append-only workspace audit trail.
-- Members live in the workspace database (DATABASE_URL), so the actor's display
-- name and the target's label are snapshotted at write time ("actorName",
-- "targetLabel") and never joined later. metadata must never hold secret values;
-- lib/audit/events.ts allows only per-action metadata keys (strict schemas).
-- ip is stored for admins/forensics but never returned by the query API.
-- Writer: lib/audit/record.ts. Query API (later PR) pages on
-- ("workspaceId", "createdAt" DESC, id DESC), optionally filtered by category.
-- Rollback: DROP TABLE IF EXISTS workspace_audit_events;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS workspace_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" uuid NOT NULL,
  "actorType" text NOT NULL CHECK ("actorType" IN ('user', 'bot', 'token', 'system')),
  "actorId" text CHECK (length("actorId") BETWEEN 1 AND 200),
  "actorName" text NOT NULL CHECK (length("actorName") BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(action) <= 80),
  category text NOT NULL CHECK (category IN ('security', 'secret', 'permission', 'member', 'billing')),
  "targetType" text CHECK (length("targetType") BETWEEN 1 AND 40),
  "targetId" text CHECK (length("targetId") BETWEEN 1 AND 200),
  "targetLabel" text CHECK (length("targetLabel") BETWEEN 1 AND 200),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192),
  ip inet,
  "geoCity" text CHECK (length("geoCity") BETWEEN 1 AND 120),
  "geoCountry" text CHECK ("geoCountry" ~ '^[A-Z]{2}$'),
  "geoRegion" text CHECK ("geoRegion" ~ '^[A-Z0-9]{1,3}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("actorType" = 'system' OR "actorId" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS workspace_audit_events_ws_created_idx
  ON workspace_audit_events ("workspaceId", "createdAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS workspace_audit_events_ws_category_created_idx
  ON workspace_audit_events ("workspaceId", category, "createdAt" DESC, id DESC);

COMMIT;
