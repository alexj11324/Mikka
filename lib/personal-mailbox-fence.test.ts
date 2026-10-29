import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeMailboxFence } from './personal-mailbox-fence'
import { MailboxError, SessionMailbox } from './session-mailbox'
type MailboxPool = ConstructorParameters<typeof SessionMailbox>[0]

// A controlled row-lock/interleaving model, not a PostgreSQL emulator or proof.
// It invokes the real fence and SessionMailbox transaction, and stages writes
// until COMMIT so late admission failures cannot appear to have persisted.
function model(botId: string | null = 'bot', toolName?: string) {
  const state = { botOwner: 'owner', workspace: 'namespace', holder: 'holder', status: 'running', enabled: true, pending: true, tool: toolName ?? 'mailbox_inbox', deviceId: 'device', clock: 0, expires: 100 }
  const locks = new Set<string>(), lockOrder: string[] = [], waiting: (() => void)[] = [], queries: string[] = []
  let staged = 0, delivered = 0
  const control = { enabled: true, beforeWrite: async () => {}, beforeDeviceLock: async () => {} }
  function releaseLocks() { locks.clear(); for (const apply of waiting.splice(0)) apply() }
  function lock(name: string) { if (!locks.has(name)) lockOrder.push(name); locks.add(name) }
  async function mutate(resource: string, apply: () => void) {
    if (locks.has(resource)) await new Promise<void>(resolve => waiting.push(() => { apply(); resolve() }))
    else apply()
  }
  const client = {
    release() {},
    async query(sql: string, args: unknown[] = []) {
      queries.push(sql)
      if (sql === 'begin') return { rows: [] }
      if (sql === 'commit') { delivered += staged; staged = 0; releaseLocks(); return { rows: [] } }
      if (sql === 'rollback') { staged = 0; releaseLocks(); return { rows: [] } }
      const result = (valid: boolean, resource?: string, value = {}) => {
        if (valid && resource) lock(resource)
        return { rows: valid ? [value] : [] }
      }
      if (sql.startsWith('SELECT id FROM bots')) return result(args[1] === state.botOwner && args[2] === state.workspace, 'bot')
      if (sql.startsWith('SELECT "deviceId" FROM native_coordinator_turns')) return result(args[1] === 'owner' && args[2] === state.holder && state.status === 'running' && (args[3] === undefined || args[3] === state.deviceId), sql.includes('FOR SHARE') ? 'turn' : undefined, { deviceId: state.deviceId })
      if (sql.startsWith('SELECT 1 FROM coordinator_sessions')) return result(args[0] === 'owner' && args[1] === botId && args[2] === state.holder, 'session')
      if (sql.startsWith('SELECT id FROM devices')) { await control.beforeDeviceLock(); return result(args[0] === 'device' && args[1] === 'owner' && state.enabled, 'device') }
      if (sql.startsWith('SELECT 1 FROM native_coordinator_tools')) return result(args[0] === 'turn' && args[1] === 'call' && args[2] === state.tool && state.pending, 'tool')
      if (sql.startsWith('SELECT 1 FROM native_coordinator_turns j')) {
        assert.ok(sql.includes('clock_timestamp()'))
        return result(args[1] === 'owner' && args[2] === state.holder && args[4] === botId && args[5] === state.tool && state.status === 'running' && state.enabled && state.pending && state.clock < state.expires)
      }
      if (sql.startsWith('select * from session_mailboxes')) return { rows: [{ id: 'box', userId: 'owner', workspaceId: 'namespace', kind: botId ? 'bot' : 'coordinator', sessionKey: botId ?? 'coordinator', disabled: false }] }
      if (sql.startsWith('select 1 from bots')) return { rows: [{}], rowCount: 1 }
      if (sql.startsWith('update run_messages set "deliveredAt"')) { await control.beforeWrite(); staged++; return { rows: [] } }
      throw new Error('Unexpected model SQL: ' + sql)
    },
  }
  const fence = nativeMailboxFence({ userId: 'owner', botId, workspaceId: 'namespace', scope: { holder: 'holder', turnId: 'turn', callId: 'call' }, action: 'inbox', toolName }, () => control.enabled)
  const store = new SessionMailbox({ connect: async () => client } as unknown as MailboxPool, 'namespace', fence)
  const read = () => store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' })
  return { state, control, queries, lockOrder, mutate, read, delivered: () => delivered }
}

test('native mailbox locks Bot/device parents then turn/session/call before data; fresh authority check precedes commit', async () => {
  const h = model(); await h.read()
  assert.deepEqual(h.lockOrder, ['bot', 'device', 'turn', 'session', 'tool'])
  assert.equal(h.queries.filter(sql => sql.startsWith('SELECT 1 FROM native_coordinator_turns j')).length, 2)
  assert.equal(h.queries.at(-1), 'commit')
  assert.equal(h.delivered(), 1)
})

test('already revoked, foreign Bot namespace, wrong tool or expired native authority has no committed mailbox effect', async () => {
  const changes = [
    (h: ReturnType<typeof model>) => { h.state.status = 'closed' },
    (h: ReturnType<typeof model>) => { h.state.workspace = 'foreign' },
    (h: ReturnType<typeof model>) => { h.state.botOwner = 'other' },
    (h: ReturnType<typeof model>) => { h.state.enabled = false },
    (h: ReturnType<typeof model>) => { h.state.pending = false },
    (h: ReturnType<typeof model>) => { h.state.tool = 'stop_run' },
    (h: ReturnType<typeof model>) => { h.state.clock = 101 },
  ]
  for (const change of changes) {
    const h = model(); change(h)
    await assert.rejects(h.read(), error => error instanceof MailboxError && error.status === 409)
    assert.equal(h.delivered(), 0)
    assert.equal(h.queries.some(sql => sql.startsWith('update run_messages')), false)
  }
})

test('close, device revoke, lease replacement and tool completion wait for the modeled transaction fence', async () => {
  for (const resource of ['bot', 'turn', 'device', 'session', 'tool']) {
    const h = model()
    let entered!: () => void, resume!: () => void, applied = false
    const atWrite = new Promise<void>(resolve => { entered = resolve })
    const proceed = new Promise<void>(resolve => { resume = resolve })
    h.control.beforeWrite = async () => { entered(); await proceed }
    const operation = h.read(); await atWrite
    const revocation = h.mutate(resource, () => {
      applied = true
      if (resource === 'bot') h.state.botOwner = 'other'
      if (resource === 'turn') h.state.status = 'closed'
      if (resource === 'device') h.state.enabled = false
      if (resource === 'session') h.state.holder = 'new-holder'
      if (resource === 'tool') h.state.pending = false
    })
    assert.equal(applied, false)
    resume(); await operation; await revocation
    assert.equal(h.delivered(), 1, 'authorized operation linearizes before waiting revocation')
    assert.equal(applied, true)
    await assert.rejects(h.read(), MailboxError)
    assert.equal(h.delivered(), 1)
  }
})

test('wall-clock expiry during mailbox wait rejects before COMMIT and rolls back staged delivery', async () => {
  const h = model(); h.control.beforeWrite = async () => { h.state.clock = 101 }
  await assert.rejects(h.read(), error => error instanceof MailboxError && error.status === 409)
  assert.equal(h.queries.at(-1), 'rollback')
  assert.equal(h.delivered(), 0)
})

test('capability disabled after admission rolls back the modeled mailbox effect', async () => {
  const h = model(); h.control.beforeWrite = async () => { h.control.enabled = false }
  await assert.rejects(h.read(), error => error instanceof MailboxError && error.status === 503)
  assert.equal(h.delivered(), 0)
  assert.equal(h.queries.at(-1), 'rollback')
})


test('device hint changed while acquiring the parent lock fails closed without locking a replacement after Turn', async () => {
  const h = model(); h.control.beforeDeviceLock = async () => { h.state.deviceId = 'replacement-device' }
  await assert.rejects(h.read(), MailboxError)
  assert.equal(h.delivered(), 0)
  assert.deepEqual(h.lockOrder, ['bot', 'device'])
  assert.equal(h.queries.filter(sql => sql.startsWith('SELECT id FROM devices')).length, 1)
})


test('built-in Coordinator null Bot scope uses its exact session without inventing a Bot identity', async () => {
  const h = model(null); await h.read()
  assert.deepEqual(h.lockOrder, ['device', 'turn', 'session', 'tool'])
  assert.equal(h.queries.some(sql => sql.startsWith('SELECT id FROM bots')), false)
  assert.equal(h.delivered(), 1)
})

test('a host-selected external tool is fenced by its exact native call name', async () => {
 const h = model('bot', 'send_slack_message'); await h.read(); assert.equal(h.delivered(), 1)
 const changed = model('bot', 'send_slack_message'); changed.state.tool = 'other_tool'; await assert.rejects(changed.read(), /Native mailbox authority expired or revoked/); assert.equal(changed.delivered(), 0)
})
