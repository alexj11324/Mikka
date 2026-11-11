-- Run provenance: where a new run was dispatched from, plus opaque entry ids.
-- Nullable with no default and no backfill: older rows stay unknown (null) and
-- are never inferred as 'web'. Evidence-only; never listed, chatted or logged.
ALTER TABLE agent_runs ADD COLUMN origin text;
ALTER TABLE agent_runs ADD COLUMN "originRef" jsonb;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_origin_check
  CHECK (origin IS NULL OR origin IN ('web','slack','telegram','linear','github','api','automation','schedule','factory'));
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_origin_ref_object
  CHECK ("originRef" IS NULL OR jsonb_typeof("originRef") = 'object');
