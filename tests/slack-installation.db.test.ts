import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Client, Pool, type QueryResult } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import {
  acceptInstall,
  consumeInstall,
  installationCredential,
  installationStatus,
  providerRevoked,
  providerMemberRemoved,
  signedSender,
  startInstall,
  unlinkMember,
  uninstallForWorkspace,
  updatePreferences,
} from '../lib/slack/installation-store'
import { stateHash } from '../lib/slack/install-provider'
import { withTaskWorkspace } from '../lib/task-workspace'

test(
  'workspace Slack installations bind the single-use browser grant and freshly authorize each user',
  { skip: !dbUrl },
  async (t) => {
    const sql = new Pool({ connectionString: dbUrl }),
      env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((i) => seedUser(sql, 'slack-install-' + i)))
    const ws = await seedWorkspace(sql, a, [
      { userId: a, role: 'admin' },
      { userId: b, role: 'member' },
    ])
    const ws2 = await seedWorkspace(sql, c, [{ userId: c, role: 'admin' }])
    const app = 'A' + randomBytes(6).toString('hex').toUpperCase(),
      team = 'T' + randomBytes(6).toString('hex').toUpperCase()
    const grant = {
      appId: app,
      teamId: team,
      teamName: 'Example',
      slackUserId: 'UA',
      botUserId: 'UBOT',
      credential: { token: randomBytes(32).toString('hex'), refresh: null, expires: null },
      scopes: ['chat:write'],
    }
    t.after(async () => {
      await sql.query('DELETE FROM mikka_slack_installations WHERE app_id=$1', [app])
      await sql.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1)', [[ws.id, ws2.id]])
      await sql.query('DELETE FROM mikka_workspaces WHERE id=ANY($1)', [[ws.id, ws2.id]])
      await sql.query('DELETE FROM "user" WHERE id=ANY($1)', [[a, b, c]])
      await sql.end()
    })
    const handoff = await startInstall(sql, a, ws.id, 'handoff')
    assert.equal(await consumeInstall(sql, b, handoff, 'handoff'), null)
    assert.equal(await consumeInstall(sql, a, handoff, 'oauth'), null)
    const raced = await Promise.all([1, 2].map(() => consumeInstall(sql, a, handoff, 'handoff')))
    assert.deepEqual(raced.sort(), [null, ws.id].sort())
    const expired = await startInstall(sql, a, ws.id, 'oauth')
    await sql.query("UPDATE mikka_slack_oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [
      stateHash(expired),
    ])
    assert.equal(await consumeInstall(sql, a, expired, 'oauth'), null)
    const queries = t.mock.method(Client.prototype, 'query')
    const id = await acceptInstall(sql, a, ws.id, grant, env)
    grant.credential.token = randomBytes(32).toString('hex')
    assert.equal(await acceptInstall(sql, a, ws.id, grant, env), id)
    const writes = queries.mock.calls.filter(call => /^(INSERT INTO|SELECT .* FROM) mikka_slack_installations/i.test(String(call.arguments[0])))
    queries.mock.restore()
    const returned = await Promise.all(writes.map(async call => (await (call.result as unknown as Promise<QueryResult>)).rows))
    t.diagnostic('Bytes returned to the OAuth writer (insert, conflicted insert, existing row): ' +
      returned.map(rows => Buffer.byteLength(JSON.stringify(rows))).join(', '))
    assert.deepEqual(returned.map(rows => rows.map(row => Object.keys(row))), [[['id']], [], [['id']]])
    await assert.rejects(acceptInstall(sql, a, ws.id, { ...grant, botUserId: 'UOTHER' }, env), /slackInstallationConflict/)
    await assert.rejects(acceptInstall(sql, c, ws2.id, grant, env), /slackInstallationConflict/)
    await assert.rejects(acceptInstall(sql, b, ws.id, grant, env), /slackInstallationConflict/)
    const secret = (await sql.query('SELECT bot_secret FROM mikka_slack_installations WHERE id=$1', [id])).rows[0]
      .bot_secret
    assert.ok(secret.ciphertext && !JSON.stringify(secret).includes(grant.credential.token))
    const asA = {
      linkId: (await signedSender(sql, app, team, 'UA'))!.linkId,
      app,
      workspace: ws.id,
      owner: a,
      team,
      sender: grant.slackUserId,
      installationId: id,
    }
    assert.equal(await installationCredential(sql, asA, { env }), grant.credential.token)
    for (const changed of [
      { owner: c },
      { workspace: ws2.id },
      { sender: 'UNOT' },
      { linkId: randomUUID() },
      { team: 'TOTHER' },
      { installationId: randomUUID() },
    ])
      await assert.rejects(installationCredential(sql, { ...asA, ...changed }, { env }), /slackInstallNotAuthorized/)
    const connected = await acceptInstall(sql, b, ws.id, { ...grant, slackUserId: 'UB' }, env)
    assert.equal(connected, id)
    await updatePreferences(sql, app, b, ws.id, true, ['C123'])
    assert.deepEqual((await signedSender(sql, app, team, 'UB'))?.watched, ['C123'])
    await updatePreferences(sql, app, b, ws.id, false, [])
    assert.equal(await signedSender(sql, app, team, 'UB'), null)
    await updatePreferences(sql, app, b, ws.id, true, [])
    await sql.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [
      ws.id,
      b,
    ])
    await assert.rejects(
      withTaskWorkspace(b, ws.id, () => installationCredential(sql, { ...asA, owner: b, sender: 'UB' }, { env })),
      /workspaceAccessDenied/,
    )
    await sql.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [
      ws.id,
      b,
    ])
    const oldMember = (await signedSender(sql, app, team, 'UB'))!
    await providerMemberRemoved(sql, app, team, 'UB', 1)
    assert.ok(await signedSender(sql, app, team, 'UB'))
    await providerMemberRemoved(sql, app, 'TOTHER', 'UB', Math.ceil(Date.now() / 1000))
    assert.ok(await signedSender(sql, app, team, 'UB'))
    await providerMemberRemoved(sql, app, team, 'UB', Math.ceil(Date.now() / 1000))
    assert.equal(await signedSender(sql, app, team, 'UB'), null)
    assert.equal((await signedSender(sql, app, team, 'UA'))?.ownerId, a)
    await acceptInstall(sql, b, ws.id, { ...grant, slackUserId: 'UB' }, env)
    const newMember = (await signedSender(sql, app, team, 'UB'))!
    assert.notEqual(oldMember.linkId, newMember.linkId)
    await assert.rejects(
      installationCredential(sql, { ...asA, owner: b, sender: 'UB', linkId: oldMember.linkId }, { env }),
      /slackInstallNotAuthorized/,
    )
    assert.equal(
      await installationCredential(sql, { ...asA, owner: b, sender: 'UB', linkId: newMember.linkId }, { env }),
      grant.credential.token,
    )
    await unlinkMember(sql, app, b, ws.id)
    assert.equal(await signedSender(sql, app, team, 'UB'), null)
    assert.equal((await signedSender(sql, app, team, 'UA'))?.ownerId, a)
    await assert.rejects(
      uninstallForWorkspace(sql, app, b, ws.id, async () => true, env),
      /slackInstallNotAuthorized/,
    )
    assert.equal(await uninstallForWorkspace(sql, app, a, ws.id, async () => false, env), false)
    assert.equal((await installationStatus(sql, app, a, ws.id))?.revoking, true)
    await assert.rejects(acceptInstall(sql, a, ws.id, grant, env), /slackInstallationConflict/)
    await assert.rejects(installationCredential(sql, asA, { env }), /slackInstallNotAuthorized/)
    assert.equal(
      await uninstallForWorkspace(sql, app, a, ws.id, async (token) => token === grant.credential.token, env),
      true,
    )
    assert.equal(await signedSender(sql, app, team, 'UA'), null)
    const again = await acceptInstall(sql, a, ws.id, grant, env)
    assert.notEqual(id, again)
    await providerRevoked(sql, app, team, null, 1)
    assert.ok(await signedSender(sql, app, team, 'UA'))
    await providerRevoked(sql, app, team, 'UNOT', Math.ceil(Date.now() / 1000))
    assert.ok(await signedSender(sql, app, team, 'UA'))
    await providerRevoked(sql, app, team, 'UBOT', Math.ceil(Date.now() / 1000))
    assert.equal(await signedSender(sql, app, team, 'UA'), null)
  },
)
