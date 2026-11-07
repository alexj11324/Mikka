import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { coordinatorMessages, coordinatorSessions } from '../db/schema'

// The safety floor (decision 2026-11-02-1600): a GitHub token never persists in
// Coordinator chat or memory. The actual store functions run; only the database
// is an in-memory stand-in.
const token = 'ghu_' + 'S'.repeat(36)
const inserted: unknown[] = []
const updates: Record<string, unknown>[] = []
let memory = ''
const tx = {
  async execute() { return { rows: [] } },
  insert(table: unknown) {
    return { values(value: unknown) {
      if (table === coordinatorMessages) { inserted.push(...(value as unknown[])); return Promise.resolve() }
      assert.equal(table, coordinatorSessions)
      return { async onConflictDoNothing() {} }
    } }
  },
  select() {
    const builder = { from: () => builder, where: () => Object.assign(Promise.resolve([{ last: 0 }]), { for: async () => [{ memory }] }) }
    return builder
  },
  update(table: unknown) {
    assert.equal(table, coordinatorSessions)
    return { set(value: Record<string, unknown>) { updates.push(value); return { where: () => Object.assign(Promise.resolve(undefined), { returning: async () => [{ userId: 'owner' }] }) } } }
  },
}
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../db/index.ts', { db: { ...tx, transaction: async <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx) }, pool: { query: async () => ({ rows: [{ present: false }] }) } })
stub('../credentials/chat-guard.ts', { assertCredentialSafeChat: async () => undefined })
stub('../agent-runs.ts', { visibleRuns: () => {}, readRun: () => {} })
stub('../issue-access.ts', { issueForUser: () => {} })
stub('../issue-visibility.ts', { issueVisibility: () => {} })
stub('../task-identifier-server.ts', { taskIdentifiers: () => {} })
stub('../artifacts/store.ts', { artifactSummaries: () => {} })
stub('./wake.ts', { coordinatorEnabled: () => false, wakeCoordinator: async () => {} })
stub('../live/coordinator-session.ts', { coordinatorSessionChanged: async () => {}, coordinatorSessionScope: async () => null })

let store: typeof import('./store')
before(async () => { store = await import('./store') })

test('assistant text, tool results and the stored warning are saved with GitHub tokens masked', async () => {
  inserted.length = 0; updates.length = 0
  await store.appendMessages('owner', 'holder', [
    { role: 'assistant', content: [{ type: 'text', text: `Here: ${token}` }, { type: 'tool-call', toolCallId: 'c1', toolName: 'github_api', input: { path: '/user' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'github_api', output: { type: 'json', value: { status: 200, data: { note: `token ${token}` } } } }] },
  ], `failed with ${token}`, 'bot')
  const saved = JSON.stringify(inserted)
  assert.doesNotMatch(saved, new RegExp(token))
  assert.match(saved, /\[secret:github-token\]/)
  assert.ok(updates.some(update => update.lastError === 'failed with [secret:github-token]'))
})

test('a memory edit never stores a token', async () => {
  updates.length = 0; memory = 'earlier'
  const result = await store.editMemory('owner', current => ({ memory: `${current}\nkey ${token}`, result: { remembered: true } }), 'bot')
  assert.deepEqual(result, { remembered: true })
  const saved = updates.find(update => 'memory' in update)
  assert.equal(saved?.memory, 'earlier\nkey [secret:github-token]')
})
