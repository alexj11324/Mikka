// One-off: GitHub bot comments (deploy previews, secret scanners) were stored
// as 「回复」 suggestions with their raw Markdown and hidden metadata as the
// title. New ones are no longer made (lib/suggestions/notification.ts); this
// finds the ones already stored.
//
//   node scripts/clean-bot-suggestions.mjs           counts only, changes nothing
//   node scripts/clean-bot-suggestions.mjs --apply   deletes them
//
// The database comes from MIKKA_DATABASE_URL (or DATABASE_URL), delivered by
// Infisical; it is never printed. Only rows not yet sent or dismissed are
// touched, so no sent card or sub-agent loses its suggestion.
import pg from 'pg'

const apply = process.argv.includes('--apply')
const connectionString = process.env.MIKKA_DATABASE_URL || process.env.DATABASE_URL
if (!connectionString) throw new Error('Set MIKKA_DATABASE_URL or DATABASE_URL')

// A bot's comment, or a shown card whose title is still raw markup.
const MATCH = `source = 'github' AND action = 'reply' AND "dismissedAt" IS NULL AND (
  actor LIKE '%[bot]'
  OR (shown AND (title ~ '^\\s*\\[[^]]+\\]:' OR title LIKE '%<!--%' OR title ~ '^\\s*#{1,6}\\s'))
)`

const pool = new pg.Pool({ connectionString, max: 1 })
try {
  const { rows } = await pool.query(`SELECT coalesce(actor, '(none)') AS actor, shown, count(*)::int AS rows, count(DISTINCT "userId")::int AS people FROM suggestions WHERE ${MATCH} GROUP BY 1, 2 ORDER BY 3 DESC`)
  console.table(rows)
  console.log(`total: ${rows.reduce((sum, row) => sum + row.rows, 0)}`)
  if (apply) {
    const { rowCount } = await pool.query(`DELETE FROM suggestions WHERE ${MATCH}`)
    console.log(`deleted: ${rowCount}`)
  }
} finally { await pool.end() }
