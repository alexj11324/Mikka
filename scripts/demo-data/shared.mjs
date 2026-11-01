import { createHash } from 'node:crypto'
import { Pool } from 'pg'

/** Every demo row id starts with this, so cleanup can find them and nothing else. */
export const DEMO_PREFIX = 'de300000-'

/** A stable v4-shaped uuid for one demo row of one owner: re-running reuses it. */
export function demoId(ownerId, key) {
  const h = createHash('sha256').update(`${ownerId}:demo-data-v1:${key}`).digest('hex')
  return `${DEMO_PREFIX}${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(7, 10)}-${h.slice(10, 22)}`
}

export function parseArgs(argv) {
  const args = { apply: false, email: null, remote: null }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--apply') args.apply = true
    else if (value === '--email') args.email = argv[++i]
    else if (value === '--allow-remote') args.remote = argv[++i]
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!args.email) throw new Error('Pass --email <account email>.')
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

/** Exactly one account, or nothing is written. */
export async function findOwner(main, email) {
  const { rows } = await main.query('SELECT id, name, email FROM "user" WHERE lower(email) = lower($1)', [email])
  if (rows.length !== 1) throw new Error(`Expected one account for ${email}, found ${rows.length}.`)
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

const where = (spec, ownerParam) => `"${spec.column}"::text LIKE '${DEMO_PREFIX}%'${spec.owner ? ` AND "${spec.owner}" = ${ownerParam}` : ''}`

export async function countDemoRows(pool, tables, ownerId) {
  const counts = {}
  for (const spec of tables) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${spec.table}" WHERE ${where(spec, '$1')}`, spec.owner ? [ownerId] : [])
    counts[spec.table] = rows[0].n
  }
  return counts
}

export async function deleteDemoRows(client, tables, ownerId) {
  const counts = {}
  for (const spec of tables) {
    const result = await client.query(`DELETE FROM "${spec.table}" WHERE ${where(spec, '$1')}`, spec.owner ? [ownerId] : [])
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
