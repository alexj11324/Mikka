// Moves each Bot's retired `repository` into an Environment (drizzle/20261120044916_bot_settings.sql).
// `bots` lives in the application database and `workspace_environments` in the
// workspace database, which may be different databases, so this runs from
// scripts/migrate.mjs with both pools instead of as SQL. It is resumable and
// safe to run on every deploy: a Bot that already has an Environment is skipped,
// and the old column is left as it was for rollback.

const KEY = /^v2\/[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/
const OWNER_REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/
/** Same as lib/bot-settings.ts legacyRepositoryKey; scripts/bot-environment-backfill.test.mjs keeps them equal. */
export function legacyRepositoryKey(repository) {
  const value = typeof repository === 'string' ? repository.trim().toLowerCase().replace(/\.git$/, '') : ''
  if (!value) return null
  const key = value.startsWith('v2/') ? value : OWNER_REPO.test(value) ? `v2/github.com/${value}` : null
  return key && KEY.test(key) && key.split('/').every(part => part !== '.' && part !== '..') ? key : null
}

const EMPTY_CONFIGURATION = { runtime: 'any', harness: 'any', variables: {}, secretIds: [] }
/** Who the workspace's resource history names for a write no person made. */
export const MIGRATION_ACTOR = 'mikka:bot-environment-backfill'

/**
 * The Environment a retired repository binds: one that already lists it, else a
 * new Environment for this Bot listing only it. An existing Environment is
 * never changed, since other work may be using it. The new one gets the same
 * setup history and resource event saveEnvironment writes
 * (lib/project-resources/store.ts), under the same workspace resource lock.
 */
async function placeRepository(client, workspaceId, key, bot, actor) {
  const { rows: [listed] } = await client.query(`SELECT id FROM workspace_environments WHERE "workspaceId"=$1 AND "archivedAt" IS NULL
    AND configuration->'repositoryKeys' ? $2 ORDER BY "createdAt",id LIMIT 1`, [workspaceId, key])
  if (listed) return { id: listed.id, created: false }
  const id = crypto.randomUUID()
  const name = (typeof bot.name === 'string' && bot.name.trim() ? bot.name.trim() : key.split('/').slice(-2).join('/')).slice(0, 120)
  await client.query(`INSERT INTO workspace_environments(id,"workspaceId",name,configuration,revision,"createdBy","updatedBy") VALUES($1,$2,$3,$4::jsonb,1,$5,$5)`,
    [id, workspaceId, name, JSON.stringify({ ...EMPTY_CONFIGURATION, repositoryKeys: [key] }), actor])
  await client.query(`INSERT INTO workspace_environment_setup_versions ("workspaceId","environmentId",revision,recipe) VALUES($1,$2,1,NULL)`, [workspaceId, id])
  await client.query(`INSERT INTO workspace_resource_events(id,"workspaceId","actorId",kind,"resourceId",detail) VALUES($1,$2,$3,'environment.saved',$4,$5::jsonb)`,
    [crypto.randomUUID(), workspaceId, actor, id, JSON.stringify({ revision: 1, source: 'bot-environment-backfill', botId: bot.id })])
  return { id, created: true }
}

export async function backfillBotEnvironments(application, workspace, { batch = 200 } = {}) {
  const { rows: [ready] } = await application.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bots' AND column_name='environmentId') AS ready`)
  if (!ready.ready) return { bound: 0, created: 0, skipped: 0 }
  let after = '00000000-0000-0000-0000-000000000000', bound = 0, created = 0, skipped = 0
  for (;;) {
    const { rows } = await application.query(`SELECT id,"workspaceId",name,repository FROM bots WHERE "environmentId" IS NULL AND repository IS NOT NULL AND id>$1 ORDER BY id LIMIT $2`, [after, batch])
    if (!rows.length) break
    after = rows.at(-1).id
    for (const bot of rows) {
      const key = legacyRepositoryKey(bot.repository)
      if (!key) { skipped++; continue }
      const client = await workspace.connect()
      let placed
      try {
        await client.query('BEGIN')
        const { rows: [exists] } = await client.query('SELECT 1 FROM mikka_workspaces WHERE id=$1', [bot.workspaceId])
        if (!exists) { await client.query('ROLLBACK'); skipped++; continue }
        // saveEnvironment's lock order: team relations shared, then this workspace's resources.
        await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))`)
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('project-resources:'||$1,0))`, [bot.workspaceId])
        placed = await placeRepository(client, bot.workspaceId, key, bot, MIGRATION_ACTOR)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw new Error('bot environment backfill failed', { cause: error })
      } finally { client.release() }
      // A second deploy, or a person who picked an Environment meanwhile, wins.
      const { rowCount } = await application.query(`UPDATE bots SET "environmentId"=$1 WHERE id=$2 AND "environmentId" IS NULL`, [placed.id, bot.id])
      if (rowCount) bound++
      if (placed.created) created++
    }
  }
  return { bound, created, skipped }
}
