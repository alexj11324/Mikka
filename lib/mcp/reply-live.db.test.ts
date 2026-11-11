import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { build } from 'esbuild'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { coordinatorSessionScope } from '../live/coordinator-session'
import { liveReady } from '../live/events'
import { presenceReply } from '../live/presence'
import { LiveChannel } from '../live/channel'
import { liveTicket } from '../live/scope'
import { ScheduleStore, type WorkspaceGuard } from '../schedules/store'
import { ScheduleError, type Definition } from '../schedules/contract'
import { tokenWorkspace } from '../tokens/principal'

const target = process.env.E2E_DATABASE_URL
const valid = target && disposableDatabase(process.env, target)
  && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (process.env.REQUIRE_DB === '1') assert.ok(valid, 'matching isolated loopback *_e2e databases are required')

async function eventually(check: () => boolean, label: string, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(label)
    await delay(5)
  }
}

async function bounded<T>(promise: Promise<T>, milliseconds = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Reply did not arrive through the committed push')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

test('MCP waits use committed PG notifications; independent web observers still receive the existing live keys', { skip: !valid, timeout: 120_000 }, async t => {
  const pending: Promise<void>[] = []
  const deliveries: { ownerId: string; workspaceId: string; events: unknown }[] = []
  let onSchedule = () => {}
  let deferredScheduledWork: (() => Promise<void>)[] | null = null
  const nextServer = await import('next/server')
  const scheduler = mock.module('next/server', { namedExports: { ...nextServer,
    after: (work: () => Promise<void>) => { onSchedule(); if (deferredScheduledWork) deferredScheduledWork.push(work); else pending.push(work()) },
  } })
  const original = await import('../live/notify')
  const notification = mock.module('../live/notify', { namedExports: {
    ...original,
    sendLiveInvalidations: async (scope: { ownerId: string; workspaceId: string }, events: Parameters<typeof original.sendLiveInvalidations>[1]) => {
      // Compare which keys went where; the revisions are checked by lib/live tests.
      deliveries.push({ ...scope, events: events.map(({ kind, id }) => ({ kind, id })) })
      await original.sendLiveInvalidations(scope, events)
    },
  } })
  const require = createRequire(import.meta.url)
  const wranglerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = wranglerRequire('miniflare')
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../cloudflare/device-gateway/src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:crypto'], write: false,
  })
  const secret = 'isolated-mcp-reply-gateway-secret'
  const options = {
    workers: [{ name: 'mcp-reply-test', modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { DEVICE_SESSION: { className: 'DeviceSession', useSQLite: true } },
      bindings: { GATEWAY_PUSH_SECRET: secret } }],
    host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.WARN),
  }
  const runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options)
  const origin = (await runtime.ready).origin
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = origin
  process.env.DEVICE_GATEWAY_PUSH_SECRET = secret
  const NativeWebSocket = globalThis.WebSocket
  const sockets: { socket: WebSocket; received: unknown[]; closes: number; ready: boolean }[] = []
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      const state = { socket: this as WebSocket, received: [] as unknown[], closes: 0, ready: false }
      sockets.push(state)
      this.addEventListener('message', message => {
        if (message.data === 'pong') return
        const value = JSON.parse(String(message.data))
        if (value?.type === 'live_ready') {
          assert.deepEqual(value, liveReady(2), 'the deployed Worker explicitly supports the reply kind, and the revision keys this channel asked for')
          state.ready = true
        } else if (presenceReply(value)?.type === 'presence_ready') {
          assert.equal(new URL(String(url)).searchParams.get('presence'), '1', 'only an explicitly negotiated presence capability is transport metadata')
        } else state.received.push(value)
      })
      const close = this.close.bind(this)
      this.close = (...args) => { state.closes++; close(...args) }
    }
  }
  const independent = new Pool({ connectionString: target, max: 4 })
  observePoolCommits(independent)
  const app = await import('../db/request-scope')
  const store = await import('@/tests/support/legacy-coordinator-store')
  const live = await import('./reply-live')
  const replyObservers: { botId: string; closed: number; lost: () => boolean }[] = []
  const replies = mock.module('./reply-live', { namedExports: {
    subscribeToCoordinatorReplies: async (...args: Parameters<typeof live.subscribeToCoordinatorReplies>) => {
      const observer = await live.subscribeToCoordinatorReplies(...args)
      const row = { botId: args[1], closed: 0, lost: () => observer.lost }
      replyObservers.push(row)
      return { get lost() { return observer.lost }, close() { row.closed++; observer.close() } }
    },
  } })
  const { readCoordinatorMessages } = await import('./tools')
  const { actAs } = await import('../acting-user')
  const request = app.createRequestDatabaseScope(target!)
  const chats: { owner: string; botId: string; workspaceId: string }[] = []
  const controllers: AbortController[] = []
  const ordered = (rows: typeof deliveries) => [...rows].sort((a, b) => JSON.stringify(a.events).localeCompare(JSON.stringify(b.events)))
  function committedChatEvents(identity: { owner: string; workspaceId: string; botId: string }) {
    return [
      // The owner's open chat re-reads on the same request as its bot list row (lib/live/chats.ts).
      { ownerId: identity.owner, workspaceId: identity.workspaceId, events: [{ kind: 'bot_chat_list', id: identity.workspaceId }, { kind: 'bot_chat', id: identity.botId }] },
      { ownerId: identity.owner, workspaceId: identity.workspaceId, events: [{ kind: 'coordinator_session', id: identity.botId }] },
    ]
  }
  async function chat() {
    const owner = `mcp-reply-${randomUUID()}`
    return request.run(async () => {
      await app.pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,true,now(),now())', [owner, 'MCP reply fixture', `${owner}@example.invalid`])
      const identity = { owner, ...await seedCoordinator(owner) }
      await app.pool.query('INSERT INTO coordinator_sessions("userId","botId","leaseHolder","leaseUntil") VALUES ($1,$2,\'mcp-fixture-holder\',now()+interval \'10 minutes\') ON CONFLICT ("userId","botId") DO UPDATE SET "leaseHolder"=EXCLUDED."leaseHolder","leaseUntil"=EXCLUDED."leaseUntil"', [owner, identity.botId])
      chats.push(identity)
      return identity
    })
  }
  function waiting(identity: Awaited<ReturnType<typeof chat>>) {
    const controller = new AbortController()
    controllers.push(controller)
    const before = sockets.length
    const observerBefore = replyObservers.length
    // This independent web consumer preserves the existing CF writer coverage.
    // It does not wake MCP, which now only receives the transaction PG signal.
    const web = new LiveChannel({
      ticket: async () => liveTicket({ ownerId: identity.owner, workspaceId: identity.workspaceId }, { url: origin, secret }),
      socket: ticket => new WebSocket(ticket.url, ticket.protocol), visible: () => true,
      watchVisibility: () => () => {}, now: Date.now, monotonicNow: () => performance.now(),
      later: (callback, milliseconds) => setTimeout(callback, milliseconds),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    })
    const closeWeb = web.subscribe('coordinator_session', identity.botId, [identity.botId], () => {})
    controller.signal.addEventListener('abort', closeWeb, { once: true })
    const promise = request.run(() => actAs({ id: identity.owner, [tokenWorkspace]: identity.workspaceId }, () => readCoordinatorMessages(identity.owner, { waitSeconds: 90 }, controller.signal)))
    // A later failure still cancels this local waiter; tests never leave a 90s timer.
    void promise.catch(() => {})
    return { controller, promise, open: async () => {
      await eventually(() => sockets.length > before && sockets[before].socket.readyState === WebSocket.OPEN && sockets[before].ready, 'MCP channel did not become ready')
      await eventually(() => replyObservers.slice(observerBefore).some(row => row.botId === identity.botId), 'PG reply subscriptions did not become ready')
      assert.equal(replyObservers.findLast(row => row.botId === identity.botId)!.lost(), false)
      return sockets[before]
    } }
  }
  async function flush() {
    for (let offset = 0; offset < pending.length;) {
      const current = pending.slice(offset)
      offset = pending.length
      await Promise.all(current)
    }
  }
  try {
    await t.test('nested append waits for the real outer COMMIT; an independent reader sees the reply when notification is scheduled', async () => {
      const identity = await chat(), waiter = waiting(identity)
      await waiter.open()
      let visible: Promise<unknown> = Promise.resolve()
      const before = deliveries.length, beforeScheduled = pending.length
      try {
        onSchedule = () => {
          visible = independent.query('SELECT message FROM coordinator_messages WHERE "userId"=$1', [identity.owner]).then(result => {
            assert.equal(result.rows[0]?.message.content, 'Committed outer reply')
          })
        }
        await request.run(() => app.db.transaction(outer => app.withDatabaseTransaction(outer, async () => {
          await store.appendMessages(identity.owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Committed outer reply' }], null, identity.botId)
          assert.equal(pending.length, beforeScheduled, 'releasing an inner savepoint must not notify')
          assert.equal((await independent.query('SELECT id FROM coordinator_messages WHERE "userId"=$1', [identity.owner])).rowCount, 0)
        })))
        await visible
        await flush()
        const reply = await bounded(waiter.promise)
        assert.deepEqual(reply.messages.map(value => value.text), ['Committed outer reply'])
        assert.deepEqual(ordered(deliveries.slice(before)), ordered(committedChatEvents(identity)))
      } finally { onSchedule = () => {}; waiter.controller.abort() }
    })

    await t.test('outer rollback and a rolled-back savepoint never wake a reader', async () => {
      const identity = await chat(), before = pending.length
      await assert.rejects(request.run(() => app.db.transaction(outer => app.withDatabaseTransaction(outer, async () => {
        await store.appendMessages(identity.owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Rolled back' }], null, identity.botId)
        throw new Error('rollback outer transaction')
      }))), /rollback outer transaction/)
      assert.equal(pending.length, before)
      assert.equal((await independent.query('SELECT id FROM coordinator_messages WHERE "userId"=$1', [identity.owner])).rowCount, 0)
      await request.run(() => app.db.transaction(outer => app.withDatabaseTransaction(outer, async () => {
        await assert.rejects(app.db.transaction(inner => app.withDatabaseTransaction(inner, async () => {
          await store.appendMessages(identity.owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Reverted nested reply' }], null, identity.botId)
          throw new Error('rollback this savepoint')
        })), /rollback this savepoint/)
      })))
      assert.equal(pending.length, before)
    })

    await t.test('takeInbox, releaseLease and failTurn notify committed state and stale holders send nothing', async () => {
      const identity = await chat()
      const before = pending.length
      await request.run(() => store.takeInbox(identity.owner, 'mcp-fixture-holder', identity.botId))
      await flush()
      assert.equal(pending.length, before + 1)
      await request.run(() => store.releaseLease(identity.owner, 'wrong-holder', identity.botId))
      await request.run(() => store.failTurn(identity.owner, 'wrong-holder', 'must not apply', identity.botId))
      assert.equal(pending.length, before + 1)
      await request.run(() => store.releaseLease(identity.owner, 'mcp-fixture-holder', identity.botId))
      await flush()
      assert.equal(pending.length, before + 3, 'release invalidates both the owner list and this reply waiter')
      assert.equal((await independent.query('SELECT "leaseHolder" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2', [identity.owner, identity.botId])).rows[0].leaseHolder, null)
      await request.run(() => store.takeInbox(identity.owner, 'mcp-fixture-holder', identity.botId))
      const waiter = waiting(identity)
      try {
        await waiter.open()
        await request.run(() => store.failTurn(identity.owner, 'mcp-fixture-holder', 'Controlled turn failure', identity.botId))
        await flush()
        const reply = await bounded(waiter.promise)
        assert.equal(reply.lastError, 'Controlled turn failure')
        assert.equal(reply.replied, false)
        assert.equal(reply.working, false)
      } finally { waiter.controller.abort() }
    })

    await t.test('a separate application writer reaches MCP over PG and the independent web observer over WebSocket', async () => {
      const identity = await chat(), waiter = waiting(identity)
      try {
        const socket = await waiter.open()
        const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import', './scripts/server-test.mjs', '--import', 'tsx', 'lib/mcp/reply-writer.fixture.mts'], {
          env: { ...process.env, MCP_TEST_OWNER: identity.owner, MCP_TEST_BOT: identity.botId }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        const exited = once(child, 'exit')
        // A writer that dies never commits, so the reply cannot arrive and the
        // reply deadline alone would report "no committed push" for every cause.
        // Surface its own exit at once instead. A successful exit may still be
        // a moment ahead of the notification the parent has not read yet.
        const died = new Promise<never>((_resolve, reject) => {
          // A spawn that cannot start reports only 'error', never 'exit'.
          child.once('error', (error: Error) => reject(new Error(`the separate writer could not start: ${error.message}`)))
          child.once('exit', (code, signal) => {
            if (code === 0 && signal === null) return
            reject(new Error(`the separate writer exited before the reply arrived (code ${code}, signal ${signal}): ${stderr.trim() || stdout.trim()}`))
          })
        })
        died.catch(() => {})
        // The writer runs its module graph before it can write: measured 2.5s
        // here and 5.9s under 6x CPU saturation, on the same fixture.
        const reply = await bounded(Promise.race([waiter.promise, died]), 15_000)
        const [code, signal] = await bounded(exited, 15_000)
        assert.equal(code, 0, stderr)
        assert.equal(signal, null)
        // Diagnostics such as db_transport_sample share this stdout; only the
        // writer's own record is the fixture's result.
        const written = stdout.split('\n').flatMap(line => {
          try { const value: unknown = JSON.parse(line); return value && typeof value === 'object' && 'written' in value ? [value] : [] }
          catch { return [] }
        })
        assert.deepEqual(written, [{ written: true, notifications: 2 }])
        await eventually(() => socket.received.some(value => JSON.stringify(value) === JSON.stringify({ kind: 'coordinator_session', id: identity.botId })), 'the independent web observer did not receive the committed live key')
        assert.deepEqual(reply.messages.map(value => value.text), ['Reply from a separate writer process'])
      } finally { waiter.controller.abort() }
    })

    await t.test('a scheduled assistant report notifies the same original chat after its actual transaction', async () => {
      const identity = await chat(), sourceEventId = randomUUID()
      await independent.query('INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,\'user_message\',$4,\'{"text":"Create this controlled reminder"}\')', [sourceEventId, identity.owner, identity.botId, sourceEventId])
      let now = new Date('2030-01-01T00:00:00Z')
      const guard: WorkspaceGuard = async (owner, workspace, work) => {
        const tx = await independent.connect()
        try {
          await tx.query('BEGIN')
          if (!(await tx.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\' FOR SHARE', [workspace, owner])).rowCount) throw new ScheduleError('scheduleWorkspaceAccessDenied', 403)
          const result = await work()
          await tx.query('COMMIT')
          return result
        } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
      }
      const schedules = new ScheduleStore(independent, guard, async () => null, async () => {}, () => false, () => now)
      const definition: Definition = { title: 'Controlled reply report', timezone: 'UTC', timing: { kind: 'once', at: '2030-01-01T00:01:00Z' }, task: { kind: 'reminder', text: 'Scheduled reply body' }, misfire: 'catch_up_once', maxLatenessMinutes: 5 }
      await schedules.command({ ownerId: identity.owner, workspaceId: identity.workspaceId, botId: identity.botId, sourceEventId }, { action: 'create', requestId: randomUUID(), definition })
      const waiter = waiting(identity), before = deliveries.length
      try {
        await waiter.open()
        now = new Date('2030-01-01T00:01:00Z')
        await schedules.tick()
        await flush()
        const reply = await bounded(waiter.promise)
        assert.match(reply.messages.at(-1)!.text, /Scheduled reply body/)
        assert.deepEqual(ordered(deliveries.slice(before)), ordered(committedChatEvents(identity)))
        const count = pending.length
        await schedules.tick()
        assert.equal(pending.length, count, 'idempotent schedule replay does not republish')
      } finally { waiter.controller.abort() }
    })

    await t.test('owner and workspace isolation use the real Bot scope, and keys cannot grant data access', async () => {
      const identity = await chat(), peer = await chat()
      assert.equal(await coordinatorSessionScope(independent, independent, peer.owner, identity.botId), null)
      assert.deepEqual(await coordinatorSessionScope(independent, independent, identity.owner, identity.botId), { ownerId: identity.owner, workspaceId: identity.workspaceId })
      const waiter = waiting(identity)
      try {
        const socket = await waiter.open()
        await original.sendLiveInvalidations({ ownerId: peer.owner, workspaceId: identity.workspaceId }, [{ kind: 'coordinator_session', id: identity.botId }])
        await original.sendLiveInvalidations({ ownerId: identity.owner, workspaceId: peer.workspaceId }, [{ kind: 'coordinator_session', id: identity.botId }])
        await request.run(() => store.appendMessages(peer.owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Private peer reply' }], null, peer.botId))
        await flush()
        await delay(150)
        assert.deepEqual(socket.received, [])
        const peerRead = await request.run(() => actAs({ id: peer.owner, [tokenWorkspace]: peer.workspaceId }, () => readCoordinatorMessages(peer.owner, {})))
        assert.deepEqual(peerRead.messages.map(value => value.text), ['Private peer reply'])
        await request.run(() => store.appendMessages(identity.owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Own reply only' }], null, identity.botId))
        const ownRead = await bounded(waiter.promise)
        assert.deepEqual(ownRead.messages.map(value => value.text), ['Own reply only'])
      } finally { waiter.controller.abort() }
    })

    await t.test('workspace revocation itself wakes MCP even when the CF producer suppresses its live key', async () => {
      const identity = await chat(), waiter = waiting(identity)
      try {
        await waiter.open()
        const denied = assert.rejects(waiter.promise, /workspaceAccessDenied/)
        await independent.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [identity.workspaceId, identity.owner])
        await bounded(denied)
        assert.equal(await coordinatorSessionScope(independent, independent, identity.owner, identity.botId), null)
        const before = deliveries.length
        await request.run(() => store.appendMessages(identity.owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Must remain unread' }], null, identity.botId))
        await flush()
        assert.equal(deliveries.length, before)
      } finally { waiter.controller.abort() }
    })

    await t.test('a deferred MCP notification retains its original request database after the request context exits', async () => {
      const database = `mcp_context_${randomUUID().replaceAll('-', '')}_e2e`
      const targetUrl = new URL(target!); targetUrl.pathname = `/${database}`
      const admin = new Pool({ connectionString: target, max: 1 })
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
      const isolated = new Pool({ connectionString: targetUrl.toString(), max: 2 })
      const isolatedRequest = app.createRequestDatabaseScope(targetUrl.toString())
      const deferred: (() => Promise<void>)[] = []
      const owner = `mcp-context-${randomUUID()}`, botId = randomUUID(), intended = randomUUID(), wrong = randomUUID()
      try {
        const dir = new URL('../../drizzle/', import.meta.url)
        for (const name of orderMigrations((await readdir(dir)).filter(name => name.endsWith('.sql')))) await isolated.query(await readFile(new URL(name, dir), 'utf8'))
        for (const connection of [independent, isolated]) await connection.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,\'Context fixture\',$2,true,now(),now())', [owner, `${owner}@example.invalid`])
        for (const id of [intended, wrong]) {
          await independent.query('INSERT INTO mikka_workspaces(id,"userId",name,slug) VALUES ($1,$2,\'Context fixture\',$3)', [id, owner, `ctx-${id}`])
          await independent.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES ($1,$2,\'Context fixture\',$3,\'admin\',\'active\')', [id, owner, `${owner}@example.invalid`])
        }
        await independent.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Wrong database Bot\')', [botId, owner, wrong])
        await isolated.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Original request Bot\')', [botId, owner, intended])
        await isolated.query('INSERT INTO coordinator_sessions("userId","botId","leaseHolder","leaseUntil") VALUES ($1,$2,\'mcp-fixture-holder\',now()+interval \'10 minutes\')', [owner, botId])
        const before = deliveries.length
        deferredScheduledWork = deferred
        await isolatedRequest.run(() => store.appendMessages(owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Only the original request database' }], null, botId))
        deferredScheduledWork = null
        assert.equal(deferred.length, 2, 'the main list and reply resolvers both retain the original request')
        // Simulate after() invoking a queued callback outside the originating ALS scope.
        await Promise.all(deferred.map(work => work()))
        assert.deepEqual(ordered(deliveries.slice(before)), ordered(committedChatEvents({ owner, workspaceId: intended, botId })), 'both chat and reply keys retain the original database and tenant')
        assert.equal((await independent.query('SELECT id FROM coordinator_messages WHERE "userId"=$1', [owner])).rowCount, 0)
        assert.equal((await isolated.query('SELECT id FROM coordinator_messages WHERE "userId"=$1', [owner])).rowCount, 1)
      } finally {
        deferredScheduledWork = null
        await isolatedRequest.close()
        await dropTestDatabase(admin, database, isolated)
        await admin.end()
      }
    })

    await t.test('MCP cancellation releases the channel without changing the Coordinator lease or run state', async () => {
      const identity = await chat(), agentId = randomUUID(), runId = randomUUID()
      await independent.query('INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,\'Cancellation fixture\',\'codex\')', [agentId, identity.owner])
      await independent.query('INSERT INTO agent_runs(id,"userId","agentId","botId",status,prompt) VALUES ($1,$2,$3,$4,\'running\',\'Isolated fixture, no model\')', [runId, identity.owner, agentId, identity.botId])
      const waiter = waiting(identity)
      const socket = await waiter.open()
      const cancelled = assert.rejects(waiter.promise, /MCP request cancelled/)
      waiter.controller.abort(new Error('MCP request cancelled'))
      await cancelled
      assert.equal(socket.closes, 1)
      assert.equal(replyObservers.findLast(row => row.botId === identity.botId)!.closed, 1, 'MCP detaches its own PG subscriptions independently of the web observer')
      assert.deepEqual((await independent.query('SELECT status,"stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0], { status: 'running', stopRequestedAt: null })
      assert.equal((await independent.query('SELECT "leaseHolder" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2', [identity.owner, identity.botId])).rows[0].leaseHolder, 'mcp-fixture-holder')
    })
  } finally {
    for (const controller of controllers) controller.abort()
    onSchedule = () => {}
    await flush()
    globalThis.WebSocket = NativeWebSocket
    for (const { socket } of sockets) if (socket.readyState === NativeWebSocket.OPEN) socket.close()
    await runtime.dispose()
    notification.restore()
    replies.restore()
    scheduler.restore()
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    await request.close()
    await independent.end()
    t.diagnostic(JSON.stringify({ event: 'mcp_reply_fixtures_retained', database: new URL(target!).pathname.slice(1), ownerIds: chats.map(value => value.owner) }))
  }
})
