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

const MAX_REPOSITORIES = 100
const EMPTY_CONFIGURATION = { runtime: 'any', harness: 'any', variables: {}, secretIds: [] }
/** Who the workspace's resource history names for a write no person made. */
export const MIGRATION_ACTOR = 'mikka:bot-environment-backfill'

/**
 * The Environment the repository goes into: one that already lists it, else
 * the workspace's default (its oldest live Environment) when it has room, else
 * a new "Default" Environment. Runs in a workspace transaction holding the
 * workspace's lock, so two Bots never create two defaults.
 */
async function placeRepository(client, workspaceId, key, actor) {
  const { rows: [listed] } = await client.query(`SELECT id FROM workspace_environments WHERE "workspaceId"=$1 AND "archivedAt" IS NULL
    AND configuration->'repositoryKeys' ? $2 ORDER BY "createdAt",id LIMIT 1`, [workspaceId, key])
  if (listed) return { id: listed.id, created: false, appended: false }
  const { rows: [fallback] } = await client.query(`SELECT id,jsonb_array_length(COALESCE(configuration->'repositoryKeys','[]'::jsonb)) AS size
    FROM workspace_environments WHERE "workspaceId"=$1 AND "archivedAt" IS NULL ORDER BY "createdAt",id LIMIT 1 FOR UPDATE`, [workspaceId])
  if (fallback && fallback.size < MAX_REPOSITORIES) {
    await client.query(`UPDATE workspace_environments SET configuration=jsonb_set(configuration,'{repositoryKeys}',COALESCE(configuration->'repositoryKeys','[]'::jsonb)||to_jsonb($2::text)),
      revision=revision+1,"updatedBy"=$3,"updatedAt"=now() WHERE id=$1`, [fallback.id, key, actor])
    return { id: fallback.id, created: false, appended: true }
  }
  const id = crypto.randomUUID()
  await client.query(`INSERT INTO workspace_environments(id,"workspaceId",name,configuration,"createdBy","updatedBy") VALUES($1,$2,'Default',$3::jsonb,$4,$4)`,
    [id, workspaceId, JSON.stringify({ ...EMPTY_CONFIGURATION, repositoryKeys: [key] }), actor])
  return { id, created: true, appended: false }
}

export async function backfillBotEnvironments(application, workspace, { batch = 200 } = {}) {
  const { rows: [ready] } = await application.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bots' AND column_name='environmentId') AS ready`)
  if (!ready.ready) return { bound: 0, created: 0, skipped: 0 }
  let after = '00000000-0000-0000-0000-000000000000', bound = 0, created = 0, skipped = 0
  for (;;) {
    const { rows } = await application.query(`SELECT id,"workspaceId",repository FROM bots WHERE "environmentId" IS NULL AND repository IS NOT NULL AND id>$1 ORDER BY id LIMIT $2`, [after, batch])
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
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('bot-environment-backfill:'||$1))`, [bot.workspaceId])
        placed = await placeRepository(client, bot.workspaceId, key, MIGRATION_ACTOR)
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
