// How migrate.mjs runs one drizzle/*.sql file.
//
// Normally the whole file goes to Postgres as one query, which runs it in a
// single implicit transaction. A file whose first lines contain
//   -- migrate: no-transaction
// is instead run one statement at a time, outside any transaction, for
// statements Postgres refuses inside one (CREATE INDEX CONCURRENTLY,
// ALTER TYPE ... ADD VALUE on old servers, ...).
//
// Rules for such a file, enforced here:
// - every statement ends with `;` at the end of a line (that is the split point);
// - no dollar-quoted bodies ($$ ... $$) and no BEGIN/COMMIT, since a naive split
//   would cut them apart;
// - every statement is idempotent (IF NOT EXISTS / IF EXISTS): a failure part
//   way leaves earlier statements applied and the file unrecorded, so the next
//   deploy runs it again. A failed CREATE INDEX CONCURRENTLY leaves an INVALID
//   index that IF NOT EXISTS would then skip; drop it before retrying.

const MARKER = /^--\s*migrate:\s*no-transaction\s*$/m
const HEADER_LINES = 10

export function isNonTransactional(sql) {
  return MARKER.test(sql.split('\n').slice(0, HEADER_LINES).join('\n'))
}

/** The queries to send for one migration file, in order. */
export function migrationSteps(name, sql) {
  if (!isNonTransactional(sql)) return [sql]
  if (sql.includes('$$')) throw new Error(`migrate: ${name} is no-transaction and cannot contain $$ bodies`)
  if (/^\s*(begin|commit|start\s+transaction)\b/im.test(sql)) throw new Error(`migrate: ${name} is no-transaction and cannot manage a transaction`)
  const statements = sql.split(/;[ \t]*(?:--[^\n]*)?$/m)
    .map(chunk => chunk.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  if (statements.length === 0) throw new Error(`migrate: ${name} has no statements`)
  return statements
}
