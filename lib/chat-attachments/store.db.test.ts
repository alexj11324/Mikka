import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Pool } from 'pg'
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
    const bot = await seedBot(database, workspace.id, owner),
      otherBot = await seedBot(database, workspace.id, owner)
    const agent = await seedAgent(database, owner),
      run = await seedRun(database, { userId: owner, agentId: agent, botId: bot, status: 'running' })
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
      await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspace.id])
      await database.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspace.id])
      await database.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer, outside]])
      await Promise.all([database.end(), pool.end(), workspacePool.end()])
    })
    const bytes = Buffer.from('# 需求说明\n\n保留 Markdown 和原始文件。\n')
    const upload = async (scope: ChatFileScope) => {
      const started = await store.beginChatFile(owner, scope, {
        name: '需求说明.md',
        size: bytes.length,
        mediaType: 'text/markdown',
      })
      assert.equal('uploadUrl' in started, false, 'isolated acceptance uses the inline storage adapter')
      const file = await store.completeChatFile(owner, started.id, bytes)
      assert.deepEqual(
        await store.completeChatFile(owner, started.id, bytes),
        file,
        'completion retry preserves the immutable identity',
      )
      return file
    }
    await t.test('R2 keeps a recoverable owner through a rolled-back publication, retry and cleanup', async (t) => {
      const objects = new Map<string, Buffer>()
      const server = createServer(async (request, response) => {
        const path = request.url!
        if (!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) {
          response.writeHead(403).end()
        } else if (request.method === 'PUT') {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          objects.set(path, Buffer.concat(chunks))
          response.writeHead(200).end()
        } else if (request.method === 'DELETE') {
          objects.delete(path)
          response.writeHead(204).end()
        } else {
          response.writeHead(objects.has(path) ? 200 : 404).end(objects.get(path))
        }
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const env = {
        S3_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        S3_BUCKET: 'chat-attachment-test',
        S3_ACCESS_KEY_ID: 'local-attachment',
        S3_SECRET_ACCESS_KEY: randomUUID(),
      }
      const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
      Object.assign(process.env, env)
      t.after(() => {
        server.closeAllConnections()
        server.close()
        for (const [key, value] of Object.entries(before)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      })
      const storage = await import('@/lib/artifacts/storage')
      const data = Buffer.from('initial body')
      const changed = Buffer.from('changed body')
      const start = () => store.beginChatFile(owner, { kind: 'bot', id: bot }, {
        name: 'receipt.txt', mediaType: 'text/plain', size: data.length,
      })
      const first = await start()
      const abandoned = await start()
      const readKey = (id: string, bytes: Buffer) =>
        `chat-files/${owner}/${id}/${createHash('sha256').update(bytes).digest('hex')}`
      // Fail the metadata write in PostgreSQL after the actual signed HTTP PUT.
      const constraint = 'attachment_qa_' + randomUUID().replaceAll('-', '')
      await database.query(`ALTER TABLE chat_attachments ADD CONSTRAINT ${constraint}
        CHECK (id NOT IN ('${first.id}', '${abandoned.id}') OR state <> 'ready') NOT VALID`)
      try {
        await assert.rejects(store.completeChatFile(peer, first.id, data), { code: 'notFound' })
        for (const { id } of [first, abandoned]) {
          await assert.rejects(store.completeChatFile(owner, id, data), { code: '23514' })
          const key = readKey(id, data)
          const saved = await database.query('SELECT state,"storageKey" FROM chat_attachments WHERE id=$1', [id])
          assert.deepEqual(saved.rows[0], { state: 'uploading', storageKey: key })
          assert.deepEqual(Buffer.from(await storage.getArtifactObjectBytes(key)), data)
          await assert.rejects(store.readChatFile(owner, id), { code: 'notFound' })
        }
      } finally {
        await database.query(`ALTER TABLE chat_attachments DROP CONSTRAINT ${constraint}`)
      }
      const [published, replay] = await Promise.all([
        store.completeChatFile(owner, first.id, changed),
        store.completeChatFile(owner, first.id, changed),
      ])
      assert.deepEqual(published, replay)
      // Exercise the ordinary account deletion entry point with a completed R2-backed file.
      // The tested owner has a separate workspace; the earlier live file must survive it.
      const departed = await seedUser(database, 'attachment-delete-owner')
      const personal = await seedWorkspace(database, departed, [{ userId: departed, role: 'admin' }])
      const privateBot = await seedBot(database, personal.id, departed)
      const owned = await store.beginChatFile(departed, { kind: 'bot', id: privateBot }, {
        name: 'private.txt', mediaType: 'text/plain', size: data.length,
      })
      await store.completeChatFile(departed, owned.id, data)
      const ownedKey = (await store.readChatFile(departed, owned.id)).storageKey!
      assert.deepEqual(Buffer.from(await storage.getArtifactObjectBytes(ownedKey)), data)
      await assert.rejects(store.readChatFile(owner, owned.id), { code: 'notFound' })
      const blockedDraft = await store.beginChatFile(departed, { kind: 'bot', id: privateBot }, {
        name: 'expired.txt', mediaType: 'text/plain', size: data.length,
      })
      await store.completeChatFile(departed, blockedDraft.id, data)
      await store.removeChatFile(departed, blockedDraft.id)
      await store.removeChatFile(owner, abandoned.id)
      await database.query(`UPDATE chat_attachments SET "uploadExpiresAt"=now()-interval '1 second' WHERE id=ANY($1::uuid[])`, [[blockedDraft.id, abandoned.id]])
      const { requestAccountDeletion } = await import('@/lib/account/deletion-jobs')
      const { deleteAccount } = await import('@/lib/account/delete')
      const email = departed + '@example.invalid'
      await requestAccountDeletion(departed, email)
      await assert.rejects(database.query('SELECT mikka_account_assert_writable($1)', [departed]), { code: '55000' })
      await store.cleanupChatFiles()
      assert.equal((await database.query('SELECT 1 FROM chat_attachments WHERE id=$1', [blockedDraft.id])).rowCount, 1)
      await assert.rejects(storage.getArtifactObjectBytes(readKey(abandoned.id, data)), { code: 404 })
      // The isolated subject has no external integrations; use the original S3 deletion transport.
      const cleanup = { externalCleanup: async () => [], deleteObject: storage.deleteArtifactObject }
      const abort = 'qa_erasure_' + randomUUID().replaceAll('-', '')
      await database.query(`CREATE FUNCTION ${abort}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic final account deletion failure'; END $$`)
      try {
        await database.query(`CREATE TRIGGER ${abort} AFTER DELETE ON "user"
          FOR EACH ROW WHEN (OLD.id='${departed}') EXECUTE FUNCTION ${abort}()`)
        await assert.rejects(deleteAccount(departed, email, cleanup), { code: 'P0001' })
        const retained = await database.query('SELECT state, "storageKey" FROM chat_attachments WHERE id=$1', [owned.id])
        assert.deepEqual(retained.rows[0], { state: 'ready', storageKey: ownedKey })
        const job = await database.query('SELECT stage, "pendingObjects" FROM account_deletion_jobs WHERE "subjectUserId"=$1', [departed])
        assert.notEqual(job.rows[0].stage, 'main_deleted')
        assert.deepEqual(job.rows[0].pendingObjects, [])
        assert.deepEqual(Buffer.from(await storage.getArtifactObjectBytes(ownedKey)), data)
      } finally {
        await database.query(`DROP TRIGGER IF EXISTS ${abort} ON "user"`)
        await database.query(`DROP FUNCTION ${abort}()`)
      }
      assert.equal((await deleteAccount(departed, email, cleanup)).ok, true)
      assert.equal((await database.query('SELECT 1 FROM "user" WHERE id=$1', [departed])).rowCount, 0)
      await assert.rejects(storage.getArtifactObjectBytes(ownedKey), { code: 404 })
      assert.deepEqual(Buffer.from(await storage.getArtifactObjectBytes(readKey(first.id, changed))), changed)
      await assert.rejects(storage.getArtifactObjectBytes(readKey(first.id, data)), { code: 404 })
      assert.deepEqual(Buffer.from(await store.chatFileBytes(await store.readChatFile(owner, first.id))), changed)
      await assert.rejects(store.readChatFile(peer, first.id), { code: 'notFound' })
      assert.deepEqual(Buffer.from(await storage.getArtifactObjectBytes(readKey(first.id, changed))), changed)
      await store.removeChatFile(owner, first.id)
      await database.query(`UPDATE chat_attachments SET "uploadExpiresAt"=now()-interval '1 second' WHERE id=$1`, [first.id])
      await store.cleanupChatFiles()
      await assert.rejects(storage.getArtifactObjectBytes(readKey(first.id, changed)), { code: 404 })
    })
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
        await database.query('UPDATE agent_runs SET "deviceId"=$2,"deviceTokenId"=$3,prompt=$4 WHERE id=$1', [
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
