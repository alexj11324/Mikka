import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { openSecret, sealSecret, type Sealed } from '../secrets/crypto'
import {
  createState,
  installPlatform,
  rotateSlack,
  stateHash,
  type SlackCredential,
  type SlackGrant,
} from './install-provider'

type Database = Pick<Pool, 'connect' | 'query'>
type Installation = {
  id: string
  workspace_id: string
  app_id: string
  team_id: string
  team_name: string
  bot_user_id: string
  installed_by: string
  bot_secret: Sealed
  revoking: boolean
}
export type SlackBinding = {
  installationId: string
  linkId: string
  ownerId: string
  workspaceId: string
  teamId: string
  botUserId: string
  slackUserId: string
  watched: string[]
}
const aad = (row: Pick<Installation, 'id' | 'workspace_id' | 'app_id' | 'team_id'>) =>
  ['slack-installation:v1', row.workspace_id, row.app_id, row.team_id, row.id].join('\0')

async function transaction<T>(pool: Database, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function startInstall(pool: Database, owner: string, workspace: string, purpose: 'handoff' | 'oauth') {
  const state = createState()
  await transaction(pool, async (client) => {
    await client.query('DELETE FROM mikka_slack_oauth_states WHERE user_id=$1 AND expires_at<=now()', [owner])
    await client.query("INSERT INTO mikka_slack_oauth_states VALUES ($1,$2,$3,$4,now()+interval '10 minutes')", [
      stateHash(state),
      purpose,
      owner,
      workspace,
    ])
  })
  return state
}
export async function consumeInstall(pool: Database, owner: string, state: string, purpose: 'handoff' | 'oauth') {
  const { rows } = await pool.query<{ workspace_id: string }>(
    'DELETE FROM mikka_slack_oauth_states WHERE state_hash=$1 AND user_id=$2 AND purpose=$3 AND expires_at>now() RETURNING workspace_id',
    [stateHash(state), owner, purpose],
  )
  return rows[0]?.workspace_id ?? null
}

/** Slack installs a bot once per team/app. Further OAuth grants link verified people without transferring another workspace's installation. */
export function acceptInstall(pool: Database, owner: string, workspace: string, grant: SlackGrant, env = process.env) {
  return transaction(pool, async (client) => {
    const proposed = { id: randomUUID(), workspace_id: workspace, app_id: grant.appId, team_id: grant.teamId }
    const result = await client.query<{ id: string }>(sqlInsertInstall, [
      proposed.id,
      workspace,
      grant.appId,
      grant.teamId,
      grant.teamName,
      grant.botUserId,
      owner,
      sealSecret(JSON.stringify(grant.credential), aad(proposed), env),
      grant.scopes,
    ])
    const row =
      result.rows[0] ??
      (
        await client.query<{ id: string }>(
          'SELECT id FROM mikka_slack_installations WHERE app_id=$1 AND team_id=$2 AND workspace_id=$3' +
            ' AND bot_user_id=$4 AND NOT revoking FOR UPDATE',
          [grant.appId, grant.teamId, workspace, grant.botUserId],
        )
      ).rows[0]
    if (!row) throw new Error('slackInstallationConflict')
    const member = await client.query(
      'INSERT INTO mikka_slack_members (installation_id,user_id,slack_user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1',
      [row.id, owner, grant.slackUserId],
    )
    if (!member.rowCount) {
      const same = await client.query(
        'UPDATE mikka_slack_members SET linked_at=now() WHERE installation_id=$1 AND user_id=$2 AND slack_user_id=$3 RETURNING 1',
        [row.id, owner, grant.slackUserId],
      )
      if (!same.rowCount) throw new Error('slackInstallationConflict')
    }
    if (!result.rowCount)
      await client.query(
        'UPDATE mikka_slack_installations SET bot_secret=$2, scopes=$3, team_name=$4, installed_at=now() WHERE id=$1',
        [row.id, sealSecret(JSON.stringify(grant.credential), aad({ ...proposed, id: row.id }), env), grant.scopes, grant.teamName],
      )
    return row.id
  })
}
const sqlInsertInstall =
  'INSERT INTO mikka_slack_installations(id,workspace_id,app_id,team_id,team_name,bot_user_id,installed_by,bot_secret,scopes)' +
  ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id'

export async function signedSender(
  pool: Database,
  app: string,
  team: string,
  sender: string,
): Promise<SlackBinding | null> {
  const { rows } = await pool.query<SlackBinding>(
    'SELECT i.id AS "installationId",m.link_id AS "linkId",i.workspace_id AS "workspaceId",i.team_id AS "teamId",i.bot_user_id AS "botUserId",' +
      'm.user_id AS "ownerId",m.slack_user_id AS "slackUserId",m.watched_channels AS watched FROM mikka_slack_installations i' +
      ' JOIN mikka_slack_members m ON m.installation_id=i.id WHERE i.app_id=$1 AND i.team_id=$2 AND m.slack_user_id=$3' +
      ' AND i.bot_user_id<>m.slack_user_id AND NOT i.revoking AND m.enabled',
    [app, team, sender],
  )
  return rows[0] ?? null
}

export async function installationStatus(pool: Database, app: string, owner: string, workspace: string) {
  const { rows } = await pool.query<{
    slackUserId: string | null
    teamName: string
    connected: boolean
    enabled: boolean
    watched: string[]
    canUninstall: boolean
    revoking: boolean
  }>(
    'SELECT m.slack_user_id AS "slackUserId",i.team_name AS "teamName", m.user_id IS NOT NULL AS connected,coalesce(m.enabled,false) AS enabled,' +
      'coalesce(m.watched_channels,\'{}\') AS watched,i.installed_by=$2 AS "canUninstall",i.revoking FROM mikka_slack_installations i' +
      ' LEFT JOIN mikka_slack_members m ON m.installation_id=i.id AND m.user_id=$2 WHERE i.app_id=$1 AND i.workspace_id=$3',
    [app, owner, workspace],
  )
  return rows[0] ?? null
}

export async function updatePreferences(
  pool: Database,
  app: string,
  owner: string,
  workspace: string,
  enabled: boolean,
  watched: string[],
) {
  const result = await pool.query(
    'UPDATE mikka_slack_members m SET enabled=$4,watched_channels=$5 FROM mikka_slack_installations i' +
      ' WHERE m.installation_id=i.id AND i.app_id=$1 AND m.user_id=$2 AND i.workspace_id=$3 AND NOT i.revoking',
    [app, owner, workspace, enabled, watched],
  )
  if (!result.rowCount) throw new Error('slackInstallNotAuthorized')
}

type CredentialUse = {
  app: string
  owner: string
  workspace: string
  team?: string
  sender?: string
  installationId?: string
  linkId?: string
}
export function installationCredential(
  pool: Database,
  input: CredentialUse,
  options: { settings?: boolean; env?: NodeJS.ProcessEnv; send?: typeof fetch } = {},
) {
  return transaction(pool, async (client) => {
    const { rows } = await client.query<Installation>(
      'SELECT i.* FROM mikka_slack_installations i JOIN mikka_slack_members m ON m.installation_id=i.id' +
        ' WHERE i.app_id=$1 AND i.workspace_id=$2 AND m.user_id=$3 AND ($4::text IS NULL OR i.team_id=$4)' +
        ' AND ($5::text IS NULL OR m.slack_user_id=$5) AND ($6::uuid IS NULL OR i.id=$6) AND ($7 OR (m.enabled AND m.link_id=$8::uuid)) AND NOT i.revoking FOR UPDATE OF i',
      [
        input.app,
        input.workspace,
        input.owner,
        input.team ?? null,
        input.sender ?? null,
        input.installationId ?? null,
        options.settings === true,
        input.linkId ?? null,
      ],
    )
    const row = rows[0]
    if (!row) throw new Error('slackInstallNotAuthorized')
    return currentCredential(client, row, options.env ?? process.env, options.send)
  })
}
async function currentCredential(client: PoolClient, row: Installation, env: NodeJS.ProcessEnv, send = fetch) {
  const credential = JSON.parse(openSecret(row.bot_secret, aad(row), env)) as SlackCredential
  if (!credential.expires || credential.expires > Date.now() + 60_000) return credential.token
  const platform = installPlatform(env)
  if (!platform || !credential.refresh) throw new Error('slackInstallNotAuthorized')
  const next = await rotateSlack(platform, credential.refresh, row.team_id, row.bot_user_id, send)
  await client.query('UPDATE mikka_slack_installations SET bot_secret=$2 WHERE id=$1', [
    row.id,
    sealSecret(JSON.stringify(next), aad(row), env),
  ])
  return next.token
}

export async function unlinkMember(pool: Database, app: string, owner: string, workspace: string) {
  await pool.query(
    'DELETE FROM mikka_slack_members m USING mikka_slack_installations i WHERE m.installation_id=i.id' +
      ' AND i.app_id=$1 AND i.workspace_id=$2 AND m.user_id=$3',
    [app, workspace, owner],
  )
}

/** Cut off every Mikka reader before asking Slack to uninstall. A provider failure leaves the encrypted grant retryable by its installer. */
export async function uninstallForWorkspace(
  pool: Database,
  app: string,
  owner: string,
  workspace: string,
  uninstall: (token: string) => Promise<boolean>,
  env = process.env,
  workspaceAdmin = false,
) {
  const marked = await pool.query(
    'UPDATE mikka_slack_installations SET revoking=true WHERE app_id=$1 AND workspace_id=$2 AND (installed_by=$3 OR $4) RETURNING id',
    [app, workspace, owner, workspaceAdmin],
  )
  if (!marked.rowCount) throw new Error('slackInstallNotAuthorized')
  const id: string = marked.rows[0].id
  // Commit any rotated credential before the external call. A timeout after rotation can be retried.
  const token = await transaction(pool, async (client) => {
    const { rows } = await client.query<Installation>(
      'SELECT * FROM mikka_slack_installations WHERE id=$1 AND revoking FOR UPDATE',
      [id],
    )
    return rows.length ? currentCredential(client, rows[0], env) : null
  })
  if (!token) return true
  if (!(await uninstall(token))) return false
  await pool.query('DELETE FROM mikka_slack_installations WHERE id=$1 AND revoking', [id])
  return true
}

export async function providerRevoked(pool: Database, app: string, team: string, bot: string | null, eventAt: number) {
  await pool.query(
    'DELETE FROM mikka_slack_installations WHERE app_id=$1 AND team_id=$2 AND ($3::text IS NULL OR bot_user_id=$3)' +
      " AND date_trunc('second',installed_at)<=to_timestamp($4)",
    [app, team, bot, eventAt],
  )
}

export async function providerMemberRemoved(
  pool: Database,
  app: string,
  team: string,
  member: string,
  eventAt: number,
) {
  await pool.query(
    'DELETE FROM mikka_slack_members m USING mikka_slack_installations i WHERE i.id=m.installation_id' +
      " AND i.app_id=$1 AND i.team_id=$2 AND m.slack_user_id=$3 AND date_trunc('second',m.linked_at)<=to_timestamp($4)",
    [app, team, member, eventAt],
  )
}
