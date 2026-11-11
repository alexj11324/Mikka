import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseTimestamp } from './check-migrations.mjs'

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const timestamp = date => date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
const dateOf = id => Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10), +id.slice(10, 12), +id.slice(12, 14))

/** Creates a pending migration with a UTC ID, reserving IDs across this clone's worktrees. */
export function newMigration(slug, { root = process.cwd(), now = () => new Date() } = {}) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(slug ?? '')) throw new Error('migration:new requires a snake_case name')
  const repository = git(root, 'rev-parse', '--show-toplevel')
  const directory = join(repository, 'drizzle')
  const reservations = join(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'mikka-migration-ids')
  mkdirSync(directory, { recursive: true })
  mkdirSync(reservations, { recursive: true })
  const latest = readdirSync(directory).map(parseTimestamp).filter(Boolean).sort().at(-1)
  // Rails uses the clock unless a known migration requires the next version.
  let candidate = Math.max(Math.floor(now().getTime() / 1000) * 1000, latest ? dateOf(latest) + 1000 : 0)
  for (;;) {
    const id = timestamp(new Date(candidate))
    const name = `${id}_${slug}.sql`
    if (!parseTimestamp(name)) throw new Error('migration:new requires a valid UTC clock')
    try {
      // O_EXCL reserves the ID, not just the slug. Separate processes and Git
      // worktrees share this directory; an interrupted claim only consumes an ID.
      const claim = openSync(join(reservations, id), 'wx', 0o600)
      closeSync(claim)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      candidate += 1000
      continue
    }
    try {
      writeFileSync(join(directory, name), '-- target: MIKKA_DATABASE_URL\n\n-- Add the migration SQL here.\n', { flag: 'wx' })
      return join(directory, name)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      candidate += 1000
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--help') console.log('Usage: pnpm migration:new SNAKE_CASE_NAME\nCreates drizzle/YYYYMMDDHHMMSS_name.sql using UTC and the next known migration ID.')
    else {
      if (args.length !== 1) throw new Error('Usage: pnpm migration:new SNAKE_CASE_NAME')
      console.log(newMigration(args[0]))
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
