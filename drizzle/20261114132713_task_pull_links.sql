-- target: MIKKA_DATABASE_URL
-- Materialize the task's authorized links. Existing metadata, publication and
-- webhook writers retain the transaction that changes the task and its history.
-- Older releases can still read the original per-task metadata after rollback.
CREATE TABLE IF NOT EXISTS task_pull_links (
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  url text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  receipt jsonb NOT NULL,
  PRIMARY KEY ("issueId", url),
  CHECK (url = rtrim(receipt->>'url', '/') AND receipt ? 'url' AND jsonb_typeof(receipt->'url') = 'string'),
  CHECK (url ~ '^https://github[.]com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/pull/[1-9][0-9]*$'),
  CHECK (receipt ? 'state' AND jsonb_typeof(receipt->'state') = 'string' AND receipt->>'state' IN ('open','draft','merged','closed'))
);
CREATE INDEX IF NOT EXISTS task_pull_links_reverse_idx ON task_pull_links (lower(url), "issueId");

CREATE OR REPLACE FUNCTION mikka_task_pull_rows(document jsonb)
RETURNS TABLE(url text, ordinal integer, receipt jsonb) LANGUAGE sql IMMUTABLE AS $$
  -- The issue-number trigger can add attrs.mikka.number to a legacy document.
  -- An explicit modern pull list (including []) takes precedence over the legacy list.
  WITH metadata AS (
    SELECT coalesce(document#>'{attrs,mikka,pullRequests}', document#>'{attrs,orvilo,pullRequests}') AS pulls
  ), entries AS (
    SELECT rtrim(entry->>'url','/') AS url, ord::integer AS ordinal, entry AS receipt
    FROM metadata CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(pulls)='array' THEN pulls ELSE '[]'::jsonb END) WITH ORDINALITY AS item(entry,ord)
    WHERE jsonb_typeof(entry->'url')='string' AND length(entry->>'url') <= 500
      AND entry->>'url' ~ '^https://github[.]com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/pull/[1-9][0-9]*/?$'
      AND entry->>'state' IN ('open','draft','merged','closed')
  ) SELECT DISTINCT ON (url) url,ordinal,receipt FROM entries ORDER BY url,ordinal
$$;

CREATE OR REPLACE FUNCTION mikka_sync_task_pull_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM task_pull_links WHERE "issueId"=NEW.id;
  INSERT INTO task_pull_links ("issueId",url,ordinal,receipt)
    SELECT NEW.id, url, ordinal, receipt FROM mikka_task_pull_rows(NEW.content);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER task_pull_links_insert AFTER INSERT ON issues FOR EACH ROW
  WHEN (NEW.content#>'{attrs,mikka,pullRequests}' IS NOT NULL OR NEW.content#>'{attrs,orvilo,pullRequests}' IS NOT NULL)
  EXECUTE FUNCTION mikka_sync_task_pull_links();
CREATE OR REPLACE TRIGGER task_pull_links_update AFTER UPDATE OF content ON issues FOR EACH ROW
  WHEN (coalesce(OLD.content#>'{attrs,mikka,pullRequests}', OLD.content#>'{attrs,orvilo,pullRequests}') IS DISTINCT FROM
        coalesce(NEW.content#>'{attrs,mikka,pullRequests}', NEW.content#>'{attrs,orvilo,pullRequests}'))
  EXECUTE FUNCTION mikka_sync_task_pull_links();

INSERT INTO task_pull_links ("issueId",url,ordinal,receipt)
SELECT i.id, p.url, p.ordinal, p.receipt FROM issues i CROSS JOIN LATERAL mikka_task_pull_rows(i.content) p
ON CONFLICT ("issueId",url) DO NOTHING;
