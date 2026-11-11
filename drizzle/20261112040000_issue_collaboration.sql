-- The collaboration surface a task page needs (Capy routes/issues.md): a comment
-- with replies, a per-account seen marker, and task links.
--
-- Comments already exist, but only inside the collaborative document: the Yjs
-- state in issue_documents.state holds a `threads` map, written by
-- components/workspace/issue-editor.tsx (addThread / replyToThread) and persisted
-- by app/actions/collaboration.ts exchangeDocument. That state is an opaque
-- base64 blob: it cannot be queried by author, ordered by time, paged, or
-- replied to through a parent pointer. This table lifts a comment out of the blob
-- into a row, so a task page, an inbox count, and an Agent can read one.
--
-- Nothing here replaces the document. issue_documents keeps holding the body and
-- the discussions already anchored inside it, and no existing row moves.

CREATE TABLE IF NOT EXISTS issue_comments (
  id uuid PRIMARY KEY,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "authorId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- A person today; 'agent' and 'system' are the values an Agent's comment or an
  -- imported one will carry, so the reader never has to infer it from userId.
  "authorType" text NOT NULL DEFAULT 'user' CHECK ("authorType" IN ('user', 'agent', 'system')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  -- The comment this one replies to. Null for a top-level comment. Self-referencing
  -- so a reply is a row, not a convention about message order inside a thread.
  "parentId" uuid REFERENCES issue_comments(id) ON DELETE CASCADE,
  -- Attachments as { id, name, contentType, size } objects; a comment may have none.
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: a removed comment keeps its id so replies keep their parent, and
  -- the reader renders the gap rather than re-parenting someone else's reply.
  "deletedAt" timestamptz
);

-- A task's comments in the order a page draws them; the parent index serves the
-- reply lookup a nested render does once per comment.
CREATE INDEX IF NOT EXISTS issue_comments_issue_created_idx ON issue_comments ("issueId", "createdAt");
CREATE INDEX IF NOT EXISTS issue_comments_parent_idx ON issue_comments ("parentId") WHERE "parentId" IS NOT NULL;

-- When an account last looked at a task, for the unread marker and for
-- mention-count. PK(issueId,userId): one row per reader, never a history.
CREATE TABLE IF NOT EXISTS issue_seen (
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "seenAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("issueId", "userId")
);

-- External references attached to a task (a pull request, a provider link, a URL).
-- This is Capy's POST/DELETE :code/links, whose payload is { ref } / { target }.
-- It is deliberately NOT the task-to-task relation graph: that already exists as
-- metadata.relatedIds / blockedByIds / duplicateOfId / parentId and is written by
-- app/actions/issue-operations.ts updateIssueRelation. Keeping the two apart means
-- neither has to guess which of them a row belongs to.
CREATE TABLE IF NOT EXISTS issue_links (
  id uuid PRIMARY KEY,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  -- The reference as given: a GitHub pull URL, a Linear identifier, an external URL.
  ref text NOT NULL CHECK (length(ref) BETWEEN 1 AND 2000),
  -- The normalized form used to unlink and to deduplicate; `ref` keeps what was typed.
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 2000),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

-- One task holds a given external reference once, and unlink finds it by target.
CREATE UNIQUE INDEX IF NOT EXISTS issue_links_issue_target_key ON issue_links ("issueId", "target");
CREATE INDEX IF NOT EXISTS issue_links_issue_idx ON issue_links ("issueId", "createdAt");
