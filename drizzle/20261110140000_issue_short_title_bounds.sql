-- target: MIKKA_DATABASE_URL
-- Short titles are derived navigation labels, never the task's full title/body.
-- The previous runtime can still write a typed title verbatim into this cache
-- during rollout: discard only an invalid cache rather than reject its task.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION mikka_issue_short_title_valid(value text)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT char_length(value) BETWEEN 1 AND 60
    AND value = btrim(value, ' ')
    AND strpos(value, '  ') = 0
    -- JS \s excluding the one permitted separator, ASCII SPACE. Do not use
    -- locale-dependent POSIX [:space:] or omit NBSP/BOM and Unicode separators.
    AND value !~ U&'[\0009-\000D\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
    AND CASE
      WHEN value ~ U&'[\3040-\30FF\3400-\9FFF\F900-\FAFF\AC00-\D7AF]'
        THEN char_length(value) <= 12
      ELSE cardinality(string_to_array(value, ' ')) <= 6
    END
$$;

CREATE OR REPLACE FUNCTION mikka_normalize_issue_short_title()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."shortTitle" IS NOT NULL AND NOT mikka_issue_short_title_valid(NEW."shortTitle") THEN
    NEW."shortTitle" := NULL;
    NEW."shortTitleFrom" := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- Existing bad values are derived caches. Leave title, content, valid labels
-- and the NULL-cache rows untouched; do not rewrite them into new labels.
UPDATE issues SET "shortTitle" = NULL, "shortTitleFrom" = NULL
WHERE "shortTitle" IS NOT NULL AND NOT mikka_issue_short_title_valid("shortTitle");

DROP TRIGGER IF EXISTS issues_short_title_normalize ON issues;
CREATE TRIGGER issues_short_title_normalize
BEFORE INSERT OR UPDATE OF "shortTitle", "shortTitleFrom" ON issues
FOR EACH ROW EXECUTE FUNCTION mikka_normalize_issue_short_title();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'issues'::regclass AND conname = 'issues_short_title_compact') THEN
    ALTER TABLE issues ADD CONSTRAINT issues_short_title_compact
      CHECK (mikka_issue_short_title_valid("shortTitle"));
  END IF;
END
$$;
COMMIT;
