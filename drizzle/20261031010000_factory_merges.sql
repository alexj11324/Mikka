-- #528: Factory acceptance is the person's own merge of the candidate PR.
-- One row per merge attempt; the partial unique index keeps a double click
-- (or a merged webhook racing the click) to one active merge per candidate.
CREATE TABLE IF NOT EXISTS factory_merges (
  id uuid PRIMARY KEY,
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL,
  "userId" text NOT NULL,
  "eventId" uuid NOT NULL,
  "pullRequestUrl" text NOT NULL,
  sha text NOT NULL,
  status text NOT NULL CHECK (status IN ('merging','merged','failed')),
  source text NOT NULL CHECK (source IN ('mikka','github')),
  code text,
  "headSha" text,
  "mergeCommitSha" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "finishedAt" timestamptz,
  FOREIGN KEY ("taskId","candidateId") REFERENCES factory_candidates("taskId",id),
  UNIQUE ("taskId","eventId")
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_merges_active_key
  ON factory_merges ("taskId","candidateId") WHERE status IN ('merging','merged');
