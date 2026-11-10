import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { withChatFiles, type ChatFileScope } from '@mikka/protocol/chat-attachments'
import {
  dbUrl,
  seedUser,
  seedWorkspace,
  seedBot,
  seedAgent,
  seedRun,
} from '@/tests/support/workspace-admin-db'

test(
  'chat files keep real bytes, immutable identities and live bot/group/thread access on PostgreSQL',
  { skip: !dbUrl },
  async (t) => {
    const database = new Pool({ connectionString: dbUrl, max: 3 })
    const store = await import('./store')
    const { pool } = await import('@/lib/db')
    const { workspacePool } = await import('@/lib/workspace-db')
    const owner = await seedUser(database, 'files-owner'),
      peer = await seedUser(database, 'files-peer'),
      outside = await seedUser(database, 'files-outsider')
    const workspace = await seedWorkspace(database, owner, [
      { userId: owner, role: 'admin' },
      { userId: peer, role: 'member' },
    ])
    const otherWorkspace = await seedWorkspace(database, owner, [
      { userId: owner, role: 'admin' }, { userId: peer, role: 'member' },
    ])
    const bot = await seedBot(database, workspace.id, owner),
      otherBot = await seedBot(database, workspace.id, owner)
    const agent = await seedAgent(database, owner),
      run = await seedRun(database, { userId: owner, agentId: agent, workspaceId: workspace.id, botId: bot, status: 'running' })
    const group = randomUUID(),
      device = randomUUID(),
      tokenId = randomUUID()
    const { newDeviceToken, hashDeviceToken } = await import('@/lib/device-link')
    const token = newDeviceToken()
    await database.query(
      "INSERT INTO devices(id,\"ownerId\",name,kind) VALUES($1,$2,'Attachments fixture','local')",
      [device, owner],
    )
    await database.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)', [
      tokenId,
      owner,
      hashDeviceToken(token),
    ])
    await database.query(
      'INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,\'group\',\'Files\',$3)',
      [group, workspace.id, owner],
    )
    for (const user of [owner, peer])
      await database.query(
        'INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,\'user\',$2,\'member\')',
        [group, user],
      )
    t.after(async () => {
      await database.query('DELETE FROM chat_attachments WHERE "userId"=ANY($1::text[])', [[owner, peer]])
      await database.query('DELETE FROM conversations WHERE id=$1', [group])
      await database.query('DELETE FROM agent_runs WHERE id=$1', [run])
      await database.query('DELETE FROM device_tokens WHERE id=$1', [tokenId])
      await database.query('DELETE FROM devices WHERE id=$1', [device])
      await database.query('DELETE FROM agents WHERE id=$1', [agent])
      await database.query('DELETE FROM bots WHERE id=ANY($1::uuid[])', [[bot, otherBot]])
      await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[workspace.id, otherWorkspace.id]])
      await database.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[workspace.id, otherWorkspace.id]])
      await database.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer, outside]])
      await Promise.all([database.end(), pool.end(), workspacePool.end()])
    })
    const bytes = Buffer.from('# 需求说明\n\n保留 Markdown 和原始文件。\n')
    const upload = async (scope: ChatFileScope, actor = owner) => {
      const started = await store.beginChatFile(actor, scope, {
        name: '需求说明.md',
        size: bytes.length,
        mediaType: 'text/markdown',
      })
      assert.equal('uploadUrl' in started, false, 'isolated acceptance uses the inline storage adapter')
      const file = await store.completeChatFile(actor, started.id, bytes)
      assert.deepEqual(
        await store.completeChatFile(actor, started.id, bytes),
        file,
        'completion retry preserves the immutable identity',
      )
      return file
    }
    await t.test(
      'same-origin chunks reject gaps, altered retries and other owners while allowing exact repeats',
      async () => {
        const { CHAT_FILE_CHUNK_BYTES } = await import('@mikka/protocol/chat-attachments')
        const started = await store.beginChatFile(
          owner,
          { kind: 'bot', id: bot },
          { name: 'chunk-budget.md', mediaType: 'text/markdown', size: CHAT_FILE_CHUNK_BYTES + 17 },
        )
        const first = Buffer.alloc(CHAT_FILE_CHUNK_BYTES, 65),
          last = Buffer.alloc(17, 66)
        await assert.rejects(store.uploadChatFilePart(owner, started.id, 1, last), { code: 'unreadable' })
        await assert.rejects(store.uploadChatFilePart(peer, started.id, 0, first), { code: 'notFound' })
        assert.deepEqual(await store.uploadChatFilePart(owner, started.id, 0, first), {
          received: first.length,
        })
        assert.deepEqual(await store.uploadChatFilePart(owner, started.id, 0, first), {
          received: first.length,
        })
        await assert.rejects(store.uploadChatFilePart(owner, started.id, 0, Buffer.alloc(first.length, 67)), {
          code: 'unreadable',
        })
        assert.deepEqual(await store.uploadChatFilePart(owner, started.id, 1, last), {
          received: first.length + last.length,
        })
        await assert.rejects(store.completeChatFile(owner, started.id), { code: 'tooLong' })
        await store.removeChatFile(owner, started.id)
        await assert.rejects(store.uploadChatFilePart(owner, started.id, 1, last), { code: 'notFound' })
      },
    )
    await t.test(
      'bot files cannot cross chats or owners, and a sent file survives draft removal',
      async () => {
        const file = await upload({ kind: 'bot', id: bot })
        assert.deepEqual(
          Buffer.from(await store.chatFileBytes(await store.readChatFile(owner, file.id))),
          bytes,
        )
        await assert.rejects(store.readChatFile(peer, file.id), { code: 'notFound' })
        await assert.rejects(
          store.validateChatFiles(owner, { kind: 'bot', id: otherBot }, withChatFiles('read', [file])),
          { code: 'notFound' },
        )
        await store.validateChatFiles(owner, { kind: 'bot', id: bot }, withChatFiles('read', [file]))
        const content = await store.chatFileContent(
          owner,
          { kind: 'bot', id: bot },
          withChatFiles('read', [file]),
        )
        assert.equal(content[0].type, 'text')
        assert.match(JSON.stringify(content), /保留 Markdown 和原始文件/)
        await store.removeChatFile(owner, file.id)
        assert.ok(
          await store.readChatFile(owner, file.id),
          'removing a reused draft cannot delete an already-sent file',
        )
      },
    )
    await t.test('group drafts stay private; sent files follow current membership', async () => {
      const file = await upload({ kind: 'group', id: group })
      await assert.rejects(store.readChatFile(peer, file.id), { code: 'notFound' })
      await store.validateChatFiles(owner, { kind: 'group', id: group }, withChatFiles('', [file]))
      assert.equal((await store.readChatFile(peer, file.id)).name, file.name)
      await assert.rejects(store.readChatFile(outside, file.id), { code: 'notFound' })
      await database.query(
        'UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"=$2',
        [group, peer],
      )
      await assert.rejects(store.readChatFile(peer, file.id), { code: 'notFound' })
    })
    await t.test(
      'authenticated Agent download requires an actual live run reference and its assigned device',
      async () => {
        const { GET } = await import('@/app/v1/devices/[deviceId]/runs/[runId]/attachments/[id]/route')
        const file = await upload({ kind: 'thread', id: run })
        await store.validateChatFiles(owner, { kind: 'thread', id: run }, withChatFiles('read', [file]))
        const request = (fileId: string, deviceId = device, credential = token) =>
          GET(
            new Request(`http://localhost/mikka/v1/devices/${deviceId}/runs/${run}/attachments/${fileId}`, {
              headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${credential}` },
            }),
            { params: Promise.resolve({ deviceId, runId: run, id: fileId }) },
          )
        await database.query('UPDATE agent_runs SET "deviceId"=$2,"deviceTokenId"=$3,prompt=$4,"leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [
          run,
          device,
          tokenId,
          'No file reference',
        ])
        assert.equal((await request(file.id)).status, 404)
        await database.query('UPDATE agent_runs SET prompt=$2 WHERE id=$1', [
          run,
          withChatFiles('read', [file]),
        ])
        const response = await request(file.id)
        assert.equal(response.status, 200)
        const downloaded = await response.json()
        assert.deepEqual(Buffer.from(downloaded.data, 'base64'), bytes)
        assert.match(downloaded.text, /保留 Markdown/)
        await database.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [run])
        assert.equal((await request(file.id)).status, 404, 'an expired execution lease cannot download a retained file')
        await database.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [run])
        await database.query(`UPDATE resource_access_policies SET visibility='shared' WHERE kind='thread' AND id=$1`, [run])
        assert.equal((await request(file.id)).status, 404, 'Owner=Actor cannot expose a legacy personal local HOME through a Shared run')
        await database.query(`UPDATE resource_access_policies SET visibility='private' WHERE kind='thread' AND id=$1`, [run])
        assert.equal((await request(file.id, randomUUID())).status, 404)
        assert.equal((await request(file.id, device, 'invalid')).status, 401)
        await database.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
        assert.equal((await request(file.id)).status, 401)
        await database.query('UPDATE device_tokens SET "revokedAt"=NULL WHERE id=$1', [tokenId])
        await database.query("UPDATE agent_runs SET status='succeeded' WHERE id=$1", [run])
        assert.equal((await request(file.id)).status, 404)
        await database.query("UPDATE agent_runs SET status='running' WHERE id=$1", [run])
      },
    )
    await t.test('Shared Chat and Thread use actual Actor ACL; drafts, expiry and tenant pin remain private', async () => {
      const { botChatResourceId } = await import('@/lib/resource-access/store')
      for (const [kind, id, scope] of [
        ['chat', botChatResourceId(owner, bot), { kind: 'bot', id: bot }],
        ['thread', run, { kind: 'thread', id: run }],
      ] as const) {
        await database.query(`UPDATE resource_access_policies SET visibility='shared' WHERE kind=$1 AND id=$2`, [kind, id])
        const file = await upload(scope, peer)
        await assert.rejects(store.readChatFile(owner, file.id), { code: 'notFound' }, 'resource ownership does not reveal another uploader\'s draft')
        await store.validateChatFiles(peer, scope, withChatFiles('Shared file', [file]))
        assert.deepEqual(Buffer.from(await store.chatFileBytes(await store.readChatFile(owner, file.id))), bytes)
        await assert.rejects(store.readChatFile({ id: peer, [tokenWorkspace]: otherWorkspace.id }, file.id), { code: 'notFound' })
        await assert.rejects(database.query('UPDATE chat_attachments SET "scopeOwnerId"=$2 WHERE id=$1', [file.id, peer]), { code: '55000' })
        await assert.rejects(database.query('UPDATE chat_attachments SET "textContent"=\'changed\' WHERE id=$1', [file.id]), { code: '55000' })
        await database.query(`UPDATE resource_access_policies SET visibility='private' WHERE kind=$1 AND id=$2`, [kind, id])
        await assert.rejects(store.readChatFile(peer, file.id), { code: 'notFound' }, 'uploader identity does not bypass fresh resource revocation')
        await database.query(`INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities,"expiresAt")
          VALUES($1,$2,'account',$3,ARRAY['canReadContent'],'2000-01-01')`, [kind, id, peer])
        await assert.rejects(store.readChatFile(peer, file.id), { code: 'notFound' }, 'expired grants cannot revive the file')
        await database.query('DELETE FROM resource_access_grants WHERE "resourceKind"=$1 AND "resourceId"=$2 AND "subjectId"=$3', [kind, id, peer])
      }
    })
    await t.test('Owner transfer starts a new private Chat and retains original file custody', async () => {
      const file = await upload({ kind: 'bot', id: otherBot })
      await store.validateChatFiles(owner, { kind: 'bot', id: otherBot }, withChatFiles('Original', [file]))
      const { rows: [policy] } = await database.query(`SELECT revision FROM resource_access_policies WHERE kind='bot' AND id=$1`, [otherBot])
      const { transferOwnedBot } = await import('@/lib/workspace-admin/members')
      assert.deepEqual(await transferOwnedBot(owner, workspace.id, otherBot, peer, { expectedRevision: policy.revision, confirmPrivateTransfer: true }), { bots: 1 })
      assert.equal((await store.readChatFile(owner, file.id)).scopeOwnerId, owner)
      await assert.rejects(store.readChatFile(peer, file.id), { code: 'notFound' })
      await assert.rejects(store.validateChatFiles(owner, { kind: 'bot', id: otherBot }, withChatFiles('Wrong Chat', [file])), { code: 'notFound' })
      const next = await upload({ kind: 'bot', id: otherBot }, peer)
      assert.equal((await store.readChatFile(peer, next.id)).scopeOwnerId, peer)
    })
    await t.test('removed drafts and revoked workspace membership cannot be read or submitted', async () => {
      const file = await upload({ kind: 'thread', id: run })
      await store.removeChatFile(owner, file.id)
      await assert.rejects(store.readChatFile(owner, file.id), { code: 'notFound' })
      await assert.rejects(store.completeChatFile(owner, file.id, bytes), { code: 'notFound' })
      await assert.rejects(
        store.validateChatFiles(owner, { kind: 'thread', id: run }, withChatFiles('', [file])),
        { code: 'notFound' },
      )
      await store.cleanupChatFiles()
      const ready = await upload({ kind: 'thread', id: run })
      await database.query(
        'UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',
        [workspace.id, owner],
      )
      await assert.rejects(store.readChatFile(owner, ready.id), { code: 'notFound' })
      await database.query(
        'UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',
        [workspace.id, owner],
      )
      await store.validateChatFiles(owner, { kind: 'thread', id: run }, withChatFiles('', [ready]))
      assert.deepEqual(
        Buffer.from(await store.chatFileBytes(await store.readChatFile(owner, ready.id))),
        bytes,
      )
    })
  },
)

test('tracked attachment migration retains original Chat custody and quarantines unknown history', { skip: !dbUrl }, async () => {
  const database = new Pool({ connectionString: dbUrl })
  const schema = `attachment_custody_${randomUUID().replaceAll('-', '')}`
  const client = await database.connect()
  try {
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema}`)
    await client.query(`CREATE TABLE issues(id uuid,"userId" text,"workspaceId" uuid,"ownershipState" text);
      CREATE TABLE agent_runs(id uuid,"userId" text,"workspaceId" uuid,"issueId" uuid,"continuesRunId" uuid,"retryOf" uuid,"questionContinuation" jsonb);
      CREATE TABLE bots(id uuid,"ownerId" text,"workspaceId" uuid);
      CREATE TABLE artifacts(id uuid,"userId" text,"workspaceId" uuid,"runId" uuid,"issueId" uuid);
      CREATE TABLE coordinator_sessions("userId" text,"botId" uuid);
      CREATE TABLE conversations(id uuid,"workspaceId" uuid,kind text,"createdBy" text);
      CREATE TABLE chat_attachments(id uuid PRIMARY KEY,"userId" text,"botId" uuid,"runId" uuid,"conversationId" uuid,
        state text,name text,"mediaType" text,size integer,sha256 text,"storageKey" text,"inlineData" bytea,"textContent" text,"usedAt" timestamptz)`)
    await client.query(await readFile(new URL('../../drizzle/20261110020010_resource_acl.sql', import.meta.url), 'utf8'))
    const workspace = randomUUID(), bot = randomUUID(), unknownBot = randomUUID(), run = randomUUID()
    await client.query('INSERT INTO bots(id,"ownerId","workspaceId") VALUES($1,\'original\',$3),($2,\'recipient\',$3)', [bot, unknownBot, workspace])
    await client.query('INSERT INTO coordinator_sessions("userId","botId") VALUES(\'original\',$1)', [bot])
    await client.query('UPDATE bots SET "ownerId"=\'recipient\' WHERE id=$1', [bot])
    await client.query('INSERT INTO agent_runs(id,"userId","workspaceId") VALUES($1,\'original\',$2)', [run, workspace])
    const known = randomUUID(), unknown = randomUUID(), thread = randomUUID(), mismatch = randomUUID()
    for (const [id, owner, botId, runId] of [
      [known, 'original', bot, null], [unknown, 'original', unknownBot, null],
      [thread, 'original', null, run], [mismatch, 'recipient', null, run],
    ]) await client.query(`INSERT INTO chat_attachments(id,"userId","botId","runId",state,name,"mediaType",size,"inlineData","textContent","usedAt")
      VALUES($1,$2,$3,$4,'ready','synthetic.md','text/markdown',9,$5,'synthetic',now())`, [id, owner, botId, runId, Buffer.from('synthetic')])
    await client.query(await readFile(new URL('../../drizzle/20261110020045_chat_attachment_custody.sql', import.meta.url), 'utf8'))
    const { rows } = await client.query('SELECT id,"scopeOwnerId","workspaceId","resourceKind","resourceId","inlineData" FROM chat_attachments ORDER BY id')
    const stored = new Map(rows.map(row => [row.id, row]))
    assert.equal(stored.get(known)?.scopeOwnerId, 'original')
    assert.equal(stored.get(thread)?.resourceKind, 'thread')
    for (const id of [unknown, mismatch]) assert.equal(stored.get(id)?.workspaceId, null, 'unknown original custody remains unreadable')
    assert.ok(rows.every(row => Buffer.from(row.inlineData).equals(Buffer.from('synthetic'))), 'migration never rewrites file bytes')
    const chatId = stored.get(known)!.resourceId
    assert.deepEqual((await client.query(`SELECT mikka_resource_acl_allowed('account','original',$1,'chat',$2,'canReadContent') AS original,
      mikka_resource_acl_allowed('account','recipient',$1,'chat',$2,'canReadContent') AS recipient`, [workspace, chatId])).rows, [{ original: true, recipient: false }])
    assert.equal((await client.query(`SELECT mikka_chat_attachment_flows_to($1,'chat',$2,'thread',$3) AS allowed`, [workspace, chatId, run])).rows[0].allowed, false)
    await client.query(`UPDATE resource_access_policies SET visibility='shared' WHERE kind='chat' AND id=$1`, [chatId])
    assert.equal((await client.query(`SELECT mikka_chat_attachment_flows_to($1,'chat',$2,'thread',$3) AS allowed`, [workspace, chatId, run])).rows[0].allowed, false, 'unrelated sharing does not sever source revocation')
    await assert.rejects(client.query('UPDATE chat_attachments SET "scopeOwnerId"=\'recipient\' WHERE id=$1', [known]), { code: '55000' })
  } finally {
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA ${schema} CASCADE`)
    client.release()
    await database.end()
  }
})
