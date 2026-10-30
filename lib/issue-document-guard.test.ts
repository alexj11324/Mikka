import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as Y from 'yjs'
import { issueDocuments, issues } from './db/schema'

// A fake transaction that records every write exchangeDocument attempts; no database is opened.
const ISSUE = '6a1f6f4e-6d2c-4a3c-9a52-6a3f2f0d0c11'
const state = { content: {} as unknown, stored: [] as unknown[], writes: [] as string[] }
const rows = (table: unknown) => table === issues ? [{ id: ISSUE, userId: 'owner', scopeVersion: 1, content: state.content, scope: 'personal', linearSyncBlocked: true }] : table === issueDocuments ? state.stored : []
const tx = {
  select: () => ({ from: (table: unknown) => ({ where: () => ({ for: async () => rows(table), limit: async () => rows(table) }) }) }),
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { state.writes.push('issue_documents') } }) }),
  update: () => ({ set: () => ({ where: async () => { state.writes.push('issues.content') } }) }),
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: { transaction: (fn: (t: typeof tx) => unknown) => fn(tx) }, pool: {} } })
mock.module(new URL('./issue-access.ts', import.meta.url).href, { namedExports: { requireIssueAccess: async () => ({ issue: { id: ISSUE, userId: 'owner', scopeVersion: 1 }, user: { id: 'owner', name: 'Owner', email: 'o@example.invalid' } }) } })
mock.module(new URL('./issue-scope-authorization.ts', import.meta.url).href, { namedExports: { requireLockedIssueScope: () => {} } })
mock.module(new URL('./issue-numbering.ts', import.meta.url).href, { namedExports: { allocateIssueNumbers: async () => { throw new Error('not reached') } } })
mock.module(new URL('./task-identifier-server.ts', import.meta.url).href, { namedExports: { issueView: () => { throw new Error('not reached') } } })
mock.module(new URL('./linear-sync/dispatch.ts', import.meta.url).href, { namedExports: { dispatchLinearIssueSync: () => {} } })
const exchangeDocument: typeof import('../app/actions/collaboration').exchangeDocument = async input => (await import('../app/actions/collaboration')).exchangeDocument(input)

// What a client without the read-only guard sends: an empty document as the seed.
const emptySeed = () => { const doc = new Y.Doc(); doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]); try { return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') } finally { doc.destroy() } }

test('invalid issues.content with no issue_documents row: a seed is refused and nothing is written', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const invalid = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mystery', text: 'original body' }] }] }
  state.content = invalid; state.stored = []; state.writes = []
  const before = JSON.stringify(invalid)
  await assert.rejects(exchangeDocument({ id: ISSUE, seed: emptySeed() }), /document content invalid/)
  assert.deepEqual(state.writes, [])
  assert.equal(JSON.stringify(state.content), before)
})

test('valid issues.content with no issue_documents row still seeds and persists', async () => {
  state.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ok' }] }] }; state.stored = []; state.writes = []
  await exchangeDocument({ id: ISSUE, seed: emptySeed() })
  assert.deepEqual(state.writes, ['issue_documents', 'issues.content'])
})

test('issue creation rejects content the editor schema cannot render', async () => {
  const { createIssueForUserInTransaction } = await import('./issue-create')
  const created = await createIssueForUserInTransaction(tx as never, 'owner', { title: 'T', content: { type: 'doc', content: [{ type: 'mystery' }] }, status: 'todo', priority: 'normal' }, { kind: 'user', id: 'owner' } as never)
  assert.equal(created, null)
  assert.deepEqual(state.writes, ['issue_documents', 'issues.content'])
})
