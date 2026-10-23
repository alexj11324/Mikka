import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { ActionFailureError } from './action-error'
import { withIssueMetadata, metadataSchema, type IssueMetadata } from './issue-metadata'

// Action-layer guards of updateIssueRelation (app/actions/issue-operations.ts):
// self links, parent/duplicate/blocking cycles. Pure: the DB, auth and Linear
// dispatch are stubbed, so this runs in CI without Postgres. The issue picker
// already hides descendants, so e2e no longer exercises server-side rejection.

const OWNER = '00000000-0000-4000-8000-000000000000'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(id)
const MISSING = id(99)

type Row = { id: string; userId: string; revision: number; title: string; status: string; priority: string; content: object }
let rows: Row[] = []

const row = (rowId: string, meta: Partial<IssueMetadata> = {}): Row => ({
  id: rowId, userId: OWNER, revision: 1, title: rowId, status: 'todo', priority: 'none',
  content: withIssueMetadata({ type: 'doc', content: [] }, metadataSchema.parse(meta)),
})

// Drizzle-style builder stub: every call chains, `.for()`/`.returning()` resolve.
function chain(result: () => unknown): unknown {
  const proxy: unknown = new Proxy(() => {}, {
    get: (_t, key) => key === 'then' ? undefined : () => key === 'for' || key === 'returning' ? Promise.resolve(result()) : proxy,
  })
  return proxy
}

let updateIssueRelation: typeof import('../app/actions/issue-operations').updateIssueRelation

before(async () => {
  const file = (p: string) => new URL(p, import.meta.url).href
  mock.module(file('./db/index.ts'), { namedExports: { db: { transaction: async (fn: (tx: unknown) => unknown) => {
    const tx = {
      execute: async () => undefined,
      select: () => chain(() => rows),
      insert: () => ({ values: async () => undefined }),
      update: () => chain(() => [{ ...rows[0], revision: 2 }]),
    }
    return fn(tx)
  } } } })
  mock.module(file('./issue-access.ts'), { namedExports: {
    requireIssueAccess: async (issueId: string) => {
      const issue = rows.find(r => r.id === issueId)
      if (!issue) throw new ActionFailureError('issueNotFound' as never)
      return { issue, user: { id: OWNER } }
    },
  } })
  mock.module(file('./issue-numbering.ts'), { namedExports: { allocateIssueNumbers: async () => 1 } })
  mock.module(file('./linear-sync/dispatch.ts'), { namedExports: { dispatchLinearWork: () => {}, dispatchLinearIssueSync: () => {} } })
  ;({ updateIssueRelation } = await import('../app/actions/issue-operations'))
})

const relate = (from: string, kind: 'parent' | 'child' | 'blocks' | 'blockedBy' | 'duplicate' | 'related', targetId: string | null, remove = false) =>
  updateIssueRelation({ id: from, revision: 1, targetId, kind, remove }) as Promise<{ error?: string; issue?: unknown }>

test('self-reference is rejected for every relation kind', async () => {
  rows = [row(A)]
  for (const kind of ['parent', 'child', 'blocks', 'blockedBy', 'duplicate', 'related'] as const) {
    assert.equal((await relate(A, kind, A)).error, 'issueSelfLink', kind)
  }
})

test('parent: direct cycle rejected both ways', async () => {
  rows = [row(A), row(B, { parentId: A })] // B is A's child
  assert.equal((await relate(A, 'parent', B)).error, 'issueParentCycle')
  assert.equal((await relate(B, 'child', A)).error, 'issueParentCycle')
})

test('parent: multi-level cycles rejected (A->B->C->A and deeper)', async () => {
  rows = [row(A), row(B, { parentId: A }), row(C, { parentId: B }), row(D, { parentId: C }), row(E, { parentId: D })]
  assert.equal((await relate(A, 'parent', C)).error, 'issueParentCycle')
  assert.equal((await relate(A, 'parent', E)).error, 'issueParentCycle')
  assert.equal((await relate(E, 'child', A)).error, 'issueParentCycle')
})

test('parent: non-cycles are allowed (siblings, unrelated, re-parent to non-descendant, clear parent)', async () => {
  rows = [row(A), row(B, { parentId: A }), row(C, { parentId: A }), row(D, { parentId: B }), row(F)]
  assert.equal((await relate(B, 'parent', C)).error, undefined, 'sibling under sibling')
  assert.equal((await relate(F, 'parent', A)).error, undefined, 'unrelated issue')
  assert.equal((await relate(D, 'parent', C)).error, undefined, 're-parent to non-descendant')
  assert.equal((await relate(A, 'parent', F)).error, undefined, 'root under unrelated')
  assert.equal((await relate(B, 'parent', null)).error, undefined, 'clearing the parent')
})

test('missing targets: unknown issue fails, only parent may omit the target', async () => {
  rows = [row(A)]
  assert.equal((await relate(A, 'parent', MISSING)).error, 'issueNotFound')
  for (const kind of ['child', 'blocks', 'blockedBy', 'duplicate', 'related'] as const) {
    assert.equal((await relate(A, kind, null)).error, 'issueTargetRequired', kind)
  }
  assert.equal((await relate(A, 'parent', 'not-a-uuid')).error, 'issueRelationInvalid')
})

test('a deleted target is unavailable', async () => {
  rows = [row(A), row(B, { deletedAt: new Date().toISOString() })]
  assert.equal((await relate(A, 'parent', B)).error, 'issueTargetUnavailable')
})

test('duplicate: direct and transitive duplicate cycles rejected; a plain duplicate is allowed', async () => {
  rows = [row(A), row(B, { duplicateOfId: A }), row(C, { duplicateOfId: B }), row(D)]
  assert.equal((await relate(A, 'duplicate', B)).error, 'issueDuplicateCycle')
  assert.equal((await relate(A, 'duplicate', C)).error, 'issueDuplicateCycle')
  assert.equal((await relate(D, 'duplicate', C)).error, undefined)
  assert.equal((await relate(B, 'duplicate', A, true)).error, undefined, 'removing a duplicate never cycles')
})

test('blocking: direct, multi-level and mixed-direction cycles rejected', async () => {
  rows = [row(A), row(B, { blockedByIds: [A] }), row(C, { blockedByIds: [B] }), row(D, { blockedByIds: [C] })]
  assert.equal((await relate(A, 'blockedBy', B)).error, 'issueBlockCycle', 'A<-B while B<-A')
  assert.equal((await relate(B, 'blocks', A)).error, 'issueBlockCycle', 'same edge via blocks')
  assert.equal((await relate(A, 'blockedBy', D)).error, 'issueBlockCycle', 'A->B->C->D->A')
  assert.equal((await relate(D, 'blocks', A)).error, 'issueBlockCycle')
})

test('blocking: non-cycles allowed, repeating an existing edge is idempotent', async () => {
  rows = [row(A), row(B, { blockedByIds: [A] }), row(C), row(D)]
  assert.equal((await relate(C, 'blockedBy', A)).error, undefined, 'second issue blocked by A')
  assert.equal((await relate(C, 'blocks', D)).error, undefined, 'unrelated')
  assert.equal((await relate(B, 'blockedBy', A)).error, undefined, 'same edge again')
  assert.equal((await relate(A, 'blocks', B, true)).error, undefined, 'removal')
})

test('relation guards do not cross relation types', async () => {
  // A parent edge does not block a reverse blocking edge, and vice versa.
  rows = [row(A), row(B, { parentId: A, blockedByIds: [A] })]
  assert.equal((await relate(A, 'blockedBy', B)).error, 'issueBlockCycle')
  assert.equal((await relate(A, 'duplicate', B)).error, undefined)
  rows = [row(A), row(B, { blockedByIds: [A] })]
  assert.equal((await relate(A, 'parent', B)).error, undefined)
})
