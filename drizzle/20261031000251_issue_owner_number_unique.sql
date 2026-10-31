-- migrate: no-transaction
-- Preserve existing identifiers: duplicate historical values fail this build
-- rather than silently changing a task's public number.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issues_owner_number_unique ON issues ("userId", number);
