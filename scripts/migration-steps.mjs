import { createHash } from 'node:crypto'

// Already merged, single-statement concurrent migrations predate the directive.
// Exact bytes only: never rewrite previously executed SQL or infer mode for future files.
export const LEGACY_CONCURRENT = {
  "20261026013001_issue_search_title_idx.sql": "6998628c74b1d6a9e601e08b627c2b83ba02bf22e6514fd3750e7722c23b77e5",
  "20261026013002_issue_search_recent_idx.sql": "5a1983521da8486d9ad538d4d2fd61b8a40398dff4cc48d276f5ea5f5e9b5b28",
  "20261026013003_issue_search_number_idx.sql": "f91c53d5e410ded8aa777192b243ac2fab4e1e9dee6031ca88cc4ff1ddc058d3"
}

// How migrate.mjs reads one drizzle/*.sql file. Deliberately no SQL lexer: the rules are
// strict enough that plain text checks are safe.
//
// Header = the leading lines that are blank or `--` comments. Directives count only there:
//   -- target: DATABASE_URL       run against the workspace database (default MIKKA_DATABASE_URL)
//   -- migrate: no-transaction    run outside a transaction (CREATE INDEX CONCURRENTLY, ...)
//
// A normal file is sent as one query, which Postgres runs in one implicit transaction.
//
// The file is always executed exactly as written; the comment-stripped text is used only for
// the checks below (stripping is not string-aware, so it must never reach Postgres).
//
// A no-transaction file holds exactly ONE statement and is never split. After stripping
// comments it is rejected if a `;` sits in a comment (count differs after stripping), if it has a second semicolon, any `$` (dollar quoting), or the words
// BEGIN, COMMIT, END or ROLLBACK. Put each CONCURRENTLY index in its own file.
// For CREATE INDEX CONCURRENTLY, migrate.mjs then checks pg_index.indisvalid; a failed build
// leaves an INVALID index (which IF NOT EXISTS would silently skip next time), so an invalid
// index fails the deploy and the file is not recorded.

const DIRECTIVE_TARGET = /^--\s*target:\s*(\w+)\s*$/
const DIRECTIVE_NO_TX = /^--\s*migrate:\s*no-transaction\s*$/

export function headerLines(sql) {
  const lines = []
  for (const line of sql.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('--')) break
    lines.push(trimmed)
  }
  return lines
}

export function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '')
}

const CONCURRENT_INDEX = /^create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w]*))\s+on\b/i

/** The name Postgres stores: unquoted identifiers fold to lower case, quoted ones are kept. */
export function indexName(match) {
  return match[1] !== undefined ? match[1] : match[2].toLowerCase()
}

/**
 * Reads one migration file. Returns { target, noTransaction, sql, concurrentIndex } or throws
 * with a message naming the file.
 */
export function planMigration(name, sql) {
  const header = headerLines(sql)
  const targetLine = header.map(line => DIRECTIVE_TARGET.exec(line)).find(Boolean)
  const target = targetLine?.[1] ?? 'MIKKA_DATABASE_URL'
  const legacy = LEGACY_CONCURRENT[name] === createHash('sha256').update(sql).digest('hex')
  const noTransaction = legacy || header.some(line => DIRECTIVE_NO_TX.test(line))
  const body = stripComments(sql).trim()
  if (!body) throw new Error(`migrate: ${name} has no statements`)
  if (!noTransaction) {
    if (/\bconcurrently\b/i.test(body)) throw new Error(`migrate: ${name} uses CONCURRENTLY; put it alone in a file marked "-- migrate: no-transaction"`)
    return { target, noTransaction, sql, concurrentIndex: null }
  }
  // Comments may hide a `;` (e.g. `-- a; b`), and a `;` inside a string literal may follow
  // `--` and be stripped with it. Require the count to survive stripping, so nothing the
  // checks below cannot see reaches Postgres.
  const semicolons = (text) => (text.match(/;/g) ?? []).length
  if (!legacy && semicolons(sql) !== semicolons(body)) throw new Error(`migrate: ${name} is no-transaction and has a ; inside a comment; remove it`)
  const statement = body.replace(/;\s*$/, '').trim()
  if (statement.includes(';')) throw new Error(`migrate: ${name} is no-transaction and must contain exactly one statement`)
  if (statement.includes('$')) throw new Error(`migrate: ${name} is no-transaction and cannot use $ quoting`)
  const word = /\b(begin|commit|end|rollback)\b/i.exec(statement)
  if (word) throw new Error(`migrate: ${name} is no-transaction and cannot contain ${word[1].toUpperCase()}`)
  const concurrent = /\bconcurrently\b/i.test(statement)
  const index = CONCURRENT_INDEX.exec(statement)
  if (concurrent && !index) throw new Error(`migrate: ${name}: only CREATE [UNIQUE] INDEX CONCURRENTLY <name> ON ... is supported`)
  return { target, noTransaction, sql, concurrentIndex: index ? indexName(index) : null }
}

/** Throws unless the index exists and is valid. `query` is pg's client.query. */
export async function assertIndexValid(query, name, file) {
  const { rows } = await query('select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1 and pg_catalog.pg_table_is_visible(c.oid)', [name])
  if (rows.length === 0) throw new Error(`migrate: ${file}: index ${name} was not created`)
  if (rows.length !== 1 || !rows[0].indisvalid) throw new Error(`migrate: ${file}: index ${name} is INVALID (a concurrent build failed). Run "DROP INDEX CONCURRENTLY IF EXISTS ${name};" and deploy again. The migration was not recorded.`)
}

/**
 * Runs one planned file on `client` and records it in schema_migrations. For a concurrent
 * index the result is checked after execution; an INVALID index throws and nothing is recorded.
 */
export async function applyMigration(client, name, plan, log = console.error) {
  const query = (text, values) => client.query(text, values)
  try {
    await client.query(plan.sql)
  } catch (error) {
    // A failed concurrent build leaves an INVALID index behind; say how to clear it.
    if (plan.concurrentIndex) await assertIndexValid(query, plan.concurrentIndex, name).catch((hint) => log(hint.message))
    throw error
  }
  // Post-execution check: IF NOT EXISTS succeeds silently over an existing INVALID index.
  if (plan.concurrentIndex) await assertIndexValid(query, plan.concurrentIndex, name)
  await client.query('insert into schema_migrations (name) values ($1)', [name])
}
