import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** Narrow only implicit sharing. Workspace is the authority; the APP database
 * never joins a membership mirror or infers kind from a Task's old scope.
 * @param {{dryRun?: boolean, workspaceIds?: string[], actorId?: string}} [options]
 */
export async function repairPersonalResourcePrivacy(application, workspace, options = {}) {
  const { dryRun = true, workspaceIds = [], actorId } = options
  if (!Array.isArray(workspaceIds) || workspaceIds.some(id => typeof id !== 'string' || !uuid.test(id))) throw new Error('Invalid repair Workspace selection')
  if (!dryRun && (!workspaceIds.length || typeof actorId !== 'string' || !actorId.trim() || actorId.length > 256)) throw new Error('Apply requires explicit Workspaces and an audit actor')
  const result = { dryRun, workspaces: /** @type {{workspaceId: string, candidates: number, repaired: number}[]} */ ([]), candidates: 0, repaired: 0 }
  let cursor = null
  for (;;) {
    const { rows: batch } = await workspace.query(`SELECT id FROM mikka_workspaces
      WHERE ($1::uuid IS NULL OR id>$1) AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
        AND kind='personal' ORDER BY id LIMIT 64`, [cursor, workspaceIds.length ? workspaceIds : null])
    if (!batch.length) break
    for (const { id } of batch) {
      const tenant = await workspace.connect()
      let app
      try {
        await tenant.query('BEGIN')
        const { rows: [authority] } = await tenant.query('SELECT id,kind FROM mikka_workspaces WHERE id=$1 FOR SHARE', [id])
        if (authority?.kind !== 'personal') { await tenant.query('COMMIT'); continue }
        const item = { workspaceId: id, candidates: 0, repaired: 0 }
        app = await application.connect()
        if (dryRun) {
          const { rows: [count] } = await app.query(`SELECT count(*)::integer AS count FROM resource_access_policies
            WHERE "workspaceId"=$1 AND visibility='shared'`, [id])
          item.candidates = count.count
        } else {
          // Bounded APP transactions; keep the authoritative Workspace locked
          // through every commit. A retry only sees remaining shared policies.
          for (;;) {
            await app.query('BEGIN')
            const { rows } = await app.query(`SELECT kind,id FROM resource_access_policies
              WHERE "workspaceId"=$1 AND visibility='shared' ORDER BY kind,id LIMIT 200 FOR UPDATE`, [id])
            if (!rows.length) { await app.query('COMMIT'); break }
            await app.query("SELECT set_config('mikka.acl_actor',$1,true),set_config('mikka.acl_source','personal_resource_privacy_repair',true)", [actorId])
            const changed = await app.query(`UPDATE resource_access_policies p SET visibility='private'
              FROM jsonb_to_recordset($2::jsonb) chosen(kind text,id uuid)
              WHERE p.kind=chosen.kind AND p.id=chosen.id AND p."workspaceId"=$1 AND p.visibility='shared'`, [id, JSON.stringify(rows)])
            // The existing policy trigger records previousVisibility and the
            // audit actor/source atomically. No grant row is rewritten.
            await app.query('COMMIT')
            item.candidates += changed.rowCount
            item.repaired += changed.rowCount
          }
        }
        await tenant.query('COMMIT')
        result.workspaces.push(item)
        result.candidates += item.candidates
        result.repaired += item.repaired
      } catch (error) {
        await Promise.allSettled([tenant.query('ROLLBACK'), ...(app ? [app.query('ROLLBACK')] : [])])
        throw error
      } finally { app?.release(); tenant.release() }
    }
    cursor = batch.at(-1).id
  }
  return result
}

function databaseTarget(value) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || [...url.searchParams.keys()].some(key => !['sslmode', 'channel_binding'].includes(key)))
    throw new Error('Repair requires unambiguous PostgreSQL targets')
  return `${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`
}

/** Parse before connecting. Production is never auto-applied by build/migrate:
 * apply selects exact connection targets and explicit Workspace IDs. */
export function repairCommand(argv, env) {
  const { values } = parseArgs({ args: argv, options: {
    apply: { type: 'boolean', default: false }, workspace: { type: 'string', multiple: true }, actor: { type: 'string' },
    'app-target': { type: 'string' }, 'workspace-target': { type: 'string' },
  } })
  const appURL = env.MIKKA_DATABASE_URL, workspaceURL = env.DATABASE_URL
  const appTarget = databaseTarget(appURL), workspaceTarget = databaseTarget(workspaceURL)
  const workspaceIds = values.workspace ?? []
  if (workspaceIds.some(id => !uuid.test(id))) throw new Error('Invalid repair Workspace selection')
  if (values.apply && (!workspaceIds.length || !values.actor?.trim() || values.actor.length > 256
    || values['app-target'] !== appTarget || values['workspace-target'] !== workspaceTarget))
    throw new Error('Apply requires explicit Workspaces, actor and both exact host:port/database targets')
  return { appURL, workspaceURL, options: { dryRun: !values.apply, workspaceIds, actorId: values.actor } }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { appURL, workspaceURL, options } = repairCommand(argv, env)
  const { Pool } = await import('pg')
  const app = new Pool({ connectionString: appURL, max: 1 }), workspace = new Pool({ connectionString: workspaceURL, max: 2 })
  try { return await repairPersonalResourcePrivacy(app, workspace, options) }
  finally { await Promise.all([app.end(), workspace.end()]) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage = 'Usage: node scripts/repair-personal-resource-privacy.mjs [--workspace UUID ...] [--apply --actor ACCOUNT --app-target HOST:PORT/DATABASE --workspace-target HOST:PORT/DATABASE]. Default: dry-run. Deploy the private-default/creation/share fixes before applying; the tool preserves every explicit grant.'
  if (process.argv.includes('--help')) console.log(usage)
  else main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error('Personal resource privacy repair failed', { name: error.name, code: error.code })
    console.error(usage)
    process.exitCode = 1
  })
}
