import { createHash } from 'node:crypto'
import { Pool } from 'pg'

/**
 * Every demo row id starts with a prefix, so cleanup can find them and nothing
 * else. This is the default (the zh content set); another set passes its own
 * with --prefix, so each set is seeded and cleaned on its own.
 */
export const DEMO_PREFIX = 'de300000-'
/** A prefix is the first uuid group: `de3` and five hex digits. */
const PREFIX_SHAPE = /^de3[0-9a-f]{5}-$/

/** A stable v4-shaped uuid for one demo row of one owner: re-running reuses it. */
export function demoId(ownerId, key, prefix = DEMO_PREFIX) {
  const h = createHash('sha256').update(`${ownerId}:demo-data-v1:${key}`).digest('hex')
  return `${prefix}${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(7, 10)}-${h.slice(10, 22)}`
}

/** The content sets seed.mjs can write (content.mjs + chats.mjs, or the -en pair). */
export const CONTENT_SETS = ['zh', 'en']

export function parseArgs(argv) {
  const args = { apply: false, email: null, userId: null, remote: null, prefix: DEMO_PREFIX, content: 'zh', refreshTimes: false }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--apply') args.apply = true
    else if (value === '--email') args.email = argv[++i]
    else if (value === '--user-id') args.userId = argv[++i]
    else if (value === '--allow-remote') args.remote = argv[++i]
    else if (value === '--prefix') args.prefix = argv[++i]
    else if (value === '--content') args.content = argv[++i]
    else if (value === '--refresh-times') args.refreshTimes = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!args.email) throw new Error('Pass --email <account email>.')
  if (!PREFIX_SHAPE.test(args.prefix ?? '')) throw new Error(`--prefix must look like ${DEMO_PREFIX} (de3 + five hex digits + -).`)
  if (!CONTENT_SETS.includes(args.content)) throw new Error(`--content must be one of ${CONTENT_SETS.join(', ')}.`)
  return args
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * The two application databases: MIKKA_DATABASE_URL (users, bots, tasks, runs…)
 * and DATABASE_URL (workspaces, members, teams). A non-loopback host is refused
 * unless it is named with --allow-remote, so a stray env file cannot point a run
 * at a shared database.
 */
export function connect(args) {
  const main = process.env.MIKKA_DATABASE_URL
  const workspace = process.env.DATABASE_URL
  if (!main || !workspace) throw new Error('Set MIKKA_DATABASE_URL and DATABASE_URL.')
  const describe = url => { const u = new URL(url); return { host: u.hostname, database: u.pathname.slice(1) } }
  const targets = { main: describe(main), workspace: describe(workspace) }
  for (const target of Object.values(targets)) {
    if (!LOOPBACK.has(target.host) && target.host !== args.remote) throw new Error(`Refusing host ${target.host}; pass --allow-remote ${target.host} to confirm it.`)
  }
  return {
    targets,
    main: new Pool({ connectionString: main, max: 1 }),
    workspace: new Pool({ connectionString: workspace, max: 1 }),
  }
}

/** Exactly one account, or nothing is written; with --user-id it must also be that account. */
export async function findOwner(main, email, userId = null) {
  const { rows } = await main.query('SELECT id, name, email FROM "user" WHERE lower(email) = lower($1)', [email])
  if (rows.length !== 1) throw new Error(`Expected one account for ${email}, found ${rows.length}.`)
  if (userId && rows[0].id !== userId) throw new Error(`${email} is account ${rows[0].id}, not ${userId}.`)
  return rows[0]
}

/**
 * Every table the seed writes, in delete order (children first). `column` holds
 * the demo id; `owner`, when set, also has to match the account, so cleanup can
 * never touch another person's rows.
 */
export const MAIN_TABLES = [
  { table: 'coordinator_messages', column: 'id', owner: 'userId' },
  { table: 'coordinator_sessions', column: 'botId', owner: 'userId' },
  { table: 'artifact_versions', column: 'id' },
  { table: 'artifacts', column: 'id', owner: 'userId' },
  { table: 'run_chunks', column: 'id' },
  { table: 'agent_runs', column: 'id', owner: 'userId' },
  { table: 'agents', column: 'id', owner: 'userId' },
  { table: 'devices', column: 'id', owner: 'ownerId' },
  { table: 'issue_versions', column: 'id', owner: 'userId' },
  { table: 'issues', column: 'id', owner: 'userId' },
  { table: 'conversation_messages', column: 'id' },
  { table: 'conversation_members', column: 'conversationId' },
  { table: 'conversations', column: 'id', owner: 'createdBy' },
  { table: 'bots', column: 'id', owner: 'ownerId' },
  // The seed no longer writes facts; cleanup still removes those earlier seeds wrote.
  { table: 'user_facts', column: 'id', owner: 'userId' },
  { table: 'suggestions', column: 'id', owner: 'userId' },
  { table: 'user', column: 'id' },
]
export const WORKSPACE_TABLES = [
  { table: 'mikka_team_issues', column: 'issueId', owner: 'userId' },
  { table: 'mikka_team_members', column: 'teamId' },
  { table: 'mikka_teams', column: 'id', owner: 'userId' },
  { table: 'mikka_workspace_members', column: 'workspaceId' },
  { table: 'mikka_workspaces', column: 'id', owner: 'userId' },
]

/** The rows of one table that are this prefix's (and, with an owner column, this account's). */
export function where(spec, prefix = DEMO_PREFIX) {
  if (!PREFIX_SHAPE.test(prefix)) throw new Error(`Bad demo prefix ${prefix}`)
  return `"${spec.column}"::text LIKE '${prefix}%'${spec.owner ? ` AND "${spec.owner}" = $1` : ''}`
}

export async function countDemoRows(pool, tables, ownerId, prefix = DEMO_PREFIX) {
  const counts = {}
  for (const spec of tables) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${spec.table}" WHERE ${where(spec, prefix)}`, spec.owner ? [ownerId] : [])
    counts[spec.table] = rows[0].n
  }
  return counts
}

export async function deleteDemoRows(client, tables, ownerId, prefix = DEMO_PREFIX) {
  const counts = {}
  for (const spec of tables) {
    const result = await client.query(`DELETE FROM "${spec.table}" WHERE ${where(spec, prefix)}`, spec.owner ? [ownerId] : [])
    counts[spec.table] = result.rowCount
  }
  return counts
}

/**
 * Moves every timestamp of the demo rows by the same amount, so the newest
 * reads "a few minutes ago" again without re-seeding. Due dates inside task
 * content move by whole days. Returns the rows touched per table.
 */
export async function shiftDemoTimes(client, tables, ownerId, ms, prefix = DEMO_PREFIX) {
  const counts = {}
  const interval = `${Math.round(ms)} milliseconds`
  const days = Math.round(ms / 86_400_000)
  for (const spec of tables) {
    const { rows } = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND data_type LIKE 'timestamp%' ORDER BY ordinal_position`, [spec.table])
    const sets = rows.map(({ column_name: name }) => `"${name}" = "${name}" + $${spec.owner ? 2 : 1}::interval`)
    if (['issues', 'issue_versions'].includes(spec.table) && days) {
      const due = `content #>> '{attrs,mikka,dueDate}'`
      sets.push(`content = CASE WHEN ${due} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN jsonb_set(content, '{attrs,mikka,dueDate}', to_jsonb(to_char((${due})::date + ${days}, 'YYYY-MM-DD'))) ELSE content END`)
    }
    if (!sets.length) continue
    const result = await client.query(`UPDATE "${spec.table}" SET ${sets.join(', ')} WHERE ${where(spec, prefix)}`, spec.owner ? [ownerId, interval] : [interval])
    counts[spec.table] = result.rowCount
  }
  return counts
}

export async function inTransaction(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
