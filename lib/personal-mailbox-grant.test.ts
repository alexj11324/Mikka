import assert from 'node:assert/strict'
import test from 'node:test'
import { makeSnapshot, digest } from './agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from './agent-kit/builtin'
import { freezeWorkerDefinition, retryWorkerDefinition } from './agent-kit/worker'
import { personalWorkerMailboxTools, snapshotMailboxTools } from './personal-mailbox-capability'
import { mailboxGrantTools } from './personal-mailbox-grant'
import { SessionMailbox } from './session-mailbox'
import { personalMailboxInstructions } from './personal-mailbox-instructions'
import { executionInstructions } from './agent-kit/execution-instructions'
import { PERSONAL_MESSAGE_INSTRUCTIONS } from './personal-agent-message'

const owner = 'owner', botId = '28700000-0000-4000-8000-000000000011', namespace = '28700000-0000-4000-8000-000000000012'
const revision = '28700000-0000-4000-8000-000000000013', executionId = '28700000-0000-4000-8000-000000000014'
function fixture() {
  const snapshot = makeSnapshot(revision, 1, { ...DEFAULT_AGENT_DEFINITION, tools: ['mailbox_inbox'] }, 'HOST', { harness: 'ai_sdk', model: 'synthetic' })
  const state = { owner, key: botId as string, namespace: namespace as string | null, status: 'running', current: snapshot.definition, snapshot,
    version: revision, executionId, rowVersion: revision, headLocked: false }
  const queries: string[] = []
  const q = { async query(sql: string, params: unknown[] = []) {
    queries.push(sql)
    if (sql.startsWith('select bot_key from')) return { rows: params[0] === state.owner && params[1] === state.executionId ? [{ bot_key: state.key }] : [] }
    if (sql.startsWith('select active_version')) { if (sql.includes('for share')) state.headLocked = true; return { rows: params[0] === state.owner && params[1] === state.key ? [{ active_version: state.version, workspace_id: state.namespace }] : [] } }
    if (sql.startsWith('select snapshot')) return { rows: params[0] === state.owner && params[1] === state.key && params[2] === state.executionId ? [{ snapshot: state.snapshot, status: state.status, version_id: state.rowVersion }] : [] }
    if (sql.startsWith('select definition')) return { rows: [{ definition: state.current, digest: digest(state.current) }] }
    throw Error('Unexpected grant model SQL: ' + sql)
  } }
  const identity = { userId: owner, botId, workspaceId: namespace, executionId }
  return { q: q as unknown as Parameters<typeof mailboxGrantTools>[0], state, queries, identity }
}
test('only new host-enabled explicit parent selections freeze worker mailbox tools; old defaults remain unchanged', () => {
  const f = fixture(), input = { harness: 'codex' as const, instructions: 'Bound', prompt: 'Task', parent: f.state.snapshot, executionId }
  const old = freezeWorkerDefinition(input), oldJSON = JSON.stringify(old)
  assert.deepEqual(personalWorkerMailboxTools('codex', old), [])
  assert.deepEqual(snapshotMailboxTools(makeSnapshot(revision, 1, DEFAULT_AGENT_DEFINITION, 'HOST', { harness: 'ai_sdk', model: 'synthetic' })), [])
  const granted = freezeWorkerDefinition({ ...input, mailboxEnabled: true })
  assert.deepEqual(personalWorkerMailboxTools('codex', granted), ['mailbox_inbox'])
  assert.notEqual(old.definitionDigest, granted.definitionDigest)
  const retry = retryWorkerDefinition(granted, 'Retry')!
  assert.deepEqual(retry.mailbox, granted.mailbox); assert.equal(retry.definitionDigest, granted.definitionDigest)
  retry.mailbox!.tools.push('mailbox_send')
  assert.deepEqual(personalWorkerMailboxTools('codex', retry), [], 'edited grant fails its frozen checksum')
  assert.equal(JSON.stringify(old), oldJSON)
  for (const raw of [null, { effectiveTools: ['mailbox_send'] }, { ...granted, parent: null }]) assert.deepEqual(personalWorkerMailboxTools('codex', raw), [])
})
test('current prompt overlay retains fixed provenance policy once and names only effective mailbox tools', () => {
  const f = fixture(), before = JSON.stringify(f.state.snapshot)
  const prompt = personalMailboxInstructions(executionInstructions(f.state.snapshot), ['mailbox_inbox'])
  assert.equal(prompt.split(PERSONAL_MESSAGE_INSTRUCTIONS).length - 1, 1)
  assert.match(prompt, /Available personal mailbox tools: mailbox_inbox\./)
  assert.doesNotMatch(prompt, /mailbox_send/)
  assert.equal(JSON.stringify(f.state.snapshot), before)
})
test('frozen/current intersection preserves replay permissions and immediately reflects current revocation', async () => {
  const f = fixture()
  assert.deepEqual(await mailboxGrantTools(f.q, f.identity, true), ['mailbox_inbox'])
  assert.ok(f.queries[0].endsWith('for share')); assert.ok(f.queries[1].endsWith('for share'))
  f.state.current = { ...f.state.current, tools: ['mailbox_inbox', 'mailbox_send'] }
  assert.deepEqual(await mailboxGrantTools(f.q, f.identity), ['mailbox_inbox'])
  f.state.current = { ...f.state.current, tools: [] }
  assert.deepEqual(await mailboxGrantTools(f.q, f.identity), [])
})
test('stored parent scope/version/digest and owner are required; completed parent can still authorize its live worker', async () => {
  const f = fixture(), worker = freezeWorkerDefinition({ harness: 'codex', instructions: 'Bound', prompt: 'Task', parent: f.state.snapshot, executionId, mailboxEnabled: true })
  f.state.status = 'completed'
  assert.deepEqual(await mailboxGrantTools(f.q, { ...f.identity, worker }), ['mailbox_inbox'])
  await assert.rejects(mailboxGrantTools(f.q, f.identity), /execution unavailable/)
  await assert.rejects(mailboxGrantTools(f.q, { ...f.identity, userId: 'foreign', worker }), /parent scope/)
  await assert.rejects(mailboxGrantTools(f.q, { ...f.identity, worker: { ...worker, parent: { ...worker.parent!, definitionDigest: '0'.repeat(64) } } }), /parent scope/)
  f.state.rowVersion = 'different'; await assert.rejects(mailboxGrantTools(f.q, { ...f.identity, worker }), /execution unavailable/)
})
test('Coordinator may delegate to its owned Bot; another named Bot never supplies its parent grant', async () => {
  const f = fixture(), worker = freezeWorkerDefinition({ harness: 'codex', instructions: 'Bound', prompt: 'Task', parent: f.state.snapshot, executionId, mailboxEnabled: true })
  f.state.key = 'coordinator'; f.state.namespace = null
  assert.deepEqual(await mailboxGrantTools(f.q, { ...f.identity, worker }), ['mailbox_inbox'])
  f.state.key = 'another-bot'
  await assert.rejects(mailboxGrantTools(f.q, { ...f.identity, worker }), /parent scope/)
})
test('controlled concurrent revocation waits for the same transaction grant lock, then blocks the next effect', async () => {
  // Row-lock/interleaving model only; genuine PG behavior requires separate acceptance.
  const f = fixture(); let atWrite!: () => void, proceed!: () => void, revoke!: () => void
  const written = new Promise<void>(r => { atWrite = r }), continueWrite = new Promise<void>(r => { proceed = r })
  let committed = 0, staged = 0
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    if (sql === 'begin') return { rows: [] }
    if (sql === 'commit' || sql === 'rollback') { if (sql === 'commit') committed += staged; staged = 0; f.state.headLocked = false; revoke?.(); return { rows: [] } }
    if (sql.startsWith('select * from session_mailboxes')) return { rows: [{ userId: owner, workspaceId: namespace, kind: 'coordinator' }] }
    if (sql.startsWith('update run_messages')) { staged++; atWrite(); await continueWrite; return { rows: [] } }
    return f.q.query(sql, params)
  } }
  const store = new SessionMailbox({ connect: async () => client } as unknown as ConstructorParameters<typeof SessionMailbox>[0], namespace, async c => {
    if (!(await mailboxGrantTools(c, f.identity, true)).includes('mailbox_inbox')) throw Error('grant revoked')
  })
  const actor = { userId: owner, workspaceId: namespace, mailboxId: 'box' }, first = store.inbox(actor)
  await written; assert.equal(f.state.headLocked, true)
  let removed = false
  const revocation = new Promise<void>(r => { revoke = () => { f.state.current = { ...f.state.current, tools: [] }; removed = true; r() } })
  assert.equal(removed, false); proceed(); await first; await revocation
  assert.equal(committed, 1)
  await assert.rejects(store.inbox(actor), /revoked/)
  assert.equal(committed, 1)
})
