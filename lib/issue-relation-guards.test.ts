import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { ActionFailureError } from './action-error'
import { issueWithMetadata, withIssueMetadata, metadataSchema, readIssueMetadata, type IssueMetadata } from './issue-metadata'

// Action-layer guards of updateIssueRelation (app/actions/issue-operations.ts):
// self links, parent/duplicate/blocking cycles. Pure: the DB, auth and Linear
// dispatch are stubbed, so this runs in CI without Postgres. The issue picker
// already hides descendants, so e2e no longer exercises server-side rejection.

const OWNER = '00000000-0000-4000-8000-000000000000'
const OTHER_OWNER = '00000000-0000-4000-8000-0000000000aa'
const MEMBER = '00000000-0000-4000-8000-0000000000bb'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(id)
const WORKSPACE = id(90), OTHER_WORKSPACE = id(91)
const MISSING = id(99)

type Row = { id: string; userId: string; workspaceId: string; ownershipState: 'bound'; scope: 'personal' | 'workspace'; scopeVersion: number; revision: number; title: string; status: string; priority: string; content: object }
type Member = { issueId: string; userId: string; memberId: string }
let rows: Row[] = []
let members: Member[] = []
let actor = OWNER // the signed-in user returned by requireIssueAccess
let workspaceMembers = new Set([OWNER, MEMBER])
let workspaceLease = false
let writes: { id: string; metadata: IssueMetadata }[] = []
const reset = (next: Row[]) => { rows = next; members = []; actor = OWNER; workspaceMembers = new Set([OWNER, MEMBER]); workspaceLease = false; writes = [] }

const row = (rowId: string, meta: Partial<IssueMetadata> = {}, extra: Partial<Row> = {}): Row => ({
  id: rowId, userId: OWNER, workspaceId: WORKSPACE, ownershipState: 'bound', scope: 'workspace', scopeVersion: 1, revision: 1, title: rowId, status: 'todo', priority: 'none',
  content: withIssueMetadata({ type: 'doc', content: [] }, metadataSchema.parse(meta)), ...extra,
})

// Extract `column = value` pairs from a drizzle where() (eq/and only), so the stub
// filters like Postgres would: by owner, by member, by id.
type Chunk = { queryChunks?: Chunk[]; name?: string; table?: unknown; value?: unknown }
function conditions(node: Chunk | undefined, out: [string, unknown][] = []): [string, unknown][] {
  const chunks = node?.queryChunks ?? []
  chunks.forEach((chunk, i) => {
    if (chunk?.queryChunks) conditions(chunk, out)
    else if (chunk?.table && chunk.name && String((chunks[i + 1] as { value?: unknown[] })?.value?.[0]).trim() === '=') out.push([chunk.name, chunks[i + 2]?.value])
  })
  return out
}
const matches = (record: Record<string, unknown>, conds: [string, unknown][]) => conds.every(([key, value]) => record[key] === value)

function select(fields?: Record<string, { name: string }>) {
  let table: unknown
  let conds: [string, unknown][] = []
  const run = () => {
    const source = (table === schema.issueMembers ? members : rows) as unknown as Record<string, unknown>[]
    const hit = source.filter(record => matches(record, conds))
    return fields ? hit.map(record => Object.fromEntries(Object.entries(fields).map(([key, column]) => {
      // Attrs-only SQL has no column name. The stub still has the stored document, whose attrs are what that SQL returns.
      const value = column?.name ? record[column.name] : undefined
      return [key, value === undefined && key === 'content' ? record.content : value]
    }))) : hit
  }
  const builder = {
    from: (t: unknown) => { table = t; return builder },
    where: (c: Chunk) => { conds = conditions(c); return builder },
    orderBy: () => builder,
    for: async () => run(),
    // oxlint-disable-next-line unicorn/no-thenable -- Match the awaited Drizzle query builder.
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
  }
  return builder
}

function update() {
  let values: Partial<Row> = {}
  let conds: [string, unknown][] = []
  const builder = {
    set: (v: Partial<Row>) => { values = v; return builder },
    where: (c: Chunk) => { conds = conditions(c); return builder },
    returning: async () => rows.filter(r => matches(r, conds)).map(r => {
      writes.push({ id: r.id, metadata: readIssueMetadata(values.content ?? r.content) })
      return { ...r, ...values }
    }),
  }
  return builder
}

let updateIssueRelation: typeof import('../app/actions/issue-operations').updateIssueRelation
let schema: typeof import('./db/schema')

before(async () => {
  const file = (p: string) => new URL(p, import.meta.url).href
  schema = await import('./db/schema')
  mock.module(file('./db/index.ts'), { namedExports: { db: { transaction: async (fn: (tx: unknown) => unknown) => {
    assert.equal(workspaceLease, true, 'the relation action enters its app transaction with workspace authority already held')
    const tx = {
      execute: async () => undefined,
      select,
      insert: () => ({ values: async () => undefined }),
      update,
    }
    return fn(tx)
  } } } })
  // Access was granted at lookup time. The action must acquire its workspace
  // lease before this fixture's APP transaction; the actual cross-DB locks and
  // revocation races are exercised in issue-scope-detachment.db.test.ts.
  const access = async (issueId: string) => {
    const issue = rows.find(r => r.id === issueId)
    if (!issue) throw new ActionFailureError('issueNotFound' as never)
    return { issue, user: { id: actor } }
  }
  mock.module(file('./issue-access.ts'), { namedExports: { requireIssueAccess: access, requireIssueAccessWithoutBody: access } })
  mock.module(file('./task-workspace.ts'), { namedExports: {
    withTaskWorkspace: async (reader: string | { id: string }, workspaceId: string, work: (workspace: { id: string; kind: 'team' }) => Promise<unknown>) => {
      const userId = typeof reader === 'string' ? reader : reader.id
      if (workspaceId !== WORKSPACE || !workspaceMembers.has(userId)) throw new ActionFailureError('workspaceAccessDenied')
      workspaceLease = true
      try { return await work({ id: workspaceId, kind: 'team' }) }
      finally { workspaceLease = false }
    },
  } })
  mock.module(file('./issue-numbering.ts'), { namedExports: { allocateIssueNumbers: async () => 1 } })
  // Identifier formatting reads account data in current main; relation guards do not.
  mock.module(file('./task-identifier-server.ts'), { namedExports: {
    issueView: async (issue: Parameters<typeof issueWithMetadata>[0]) => issueWithMetadata(issue),
    taskIdentifiers: async () => new Map(),
  } })
  mock.module(file('./linear-sync/dispatch.ts'), { namedExports: { dispatchLinearWork: () => {}, dispatchLinearIssueSync: () => {} } })
  mock.module(file('./live/lists.ts'), { namedExports: { issueListChanged: async () => {} } })
  mock.module(file('./live/issue-detail.ts'), { namedExports: { issueRelationsChanged: async () => {}, relationIds: () => [] } })
  ;({ updateIssueRelation } = await import('../app/actions/issue-operations'))
})

const relate = (from: string, kind: 'parent' | 'child' | 'blocks' | 'blockedBy' | 'duplicate' | 'related', targetId: string | null, remove = false, revision = 1) =>
  updateIssueRelation({ id: from, revision, targetId, kind, remove }) as Promise<{ error?: string; issue?: unknown }>

test('self-reference is rejected for every relation kind', async () => {
  reset([row(A)])
  for (const kind of ['parent', 'child', 'blocks', 'blockedBy', 'duplicate', 'related'] as const) {
    assert.equal((await relate(A, kind, A)).error, 'issueSelfLink', kind)
  }
})

test('parent: direct cycle rejected both ways', async () => {
  reset([row(A), row(B, { parentId: A })]) // B is A's child
  assert.equal((await relate(A, 'parent', B)).error, 'issueParentCycle')
  assert.equal((await relate(B, 'child', A)).error, 'issueParentCycle')
})

test('parent: multi-level cycles rejected (A->B->C->A and deeper)', async () => {
  reset([row(A), row(B, { parentId: A }), row(C, { parentId: B }), row(D, { parentId: C }), row(E, { parentId: D })])
  assert.equal((await relate(A, 'parent', C)).error, 'issueParentCycle')
  assert.equal((await relate(A, 'parent', E)).error, 'issueParentCycle')
  assert.equal((await relate(E, 'child', A)).error, 'issueParentCycle')
})

test('parent: non-cycles are allowed (siblings, unrelated, re-parent to non-descendant, clear parent)', async () => {
  reset([row(A), row(B, { parentId: A }), row(C, { parentId: A }), row(D, { parentId: B }), row(F)])
  assert.equal((await relate(B, 'parent', C)).error, undefined, 'sibling under sibling')
  assert.equal((await relate(F, 'parent', A)).error, undefined, 'unrelated issue')
  assert.equal((await relate(D, 'parent', C)).error, undefined, 're-parent to non-descendant')
  assert.equal((await relate(A, 'parent', F)).error, undefined, 'root under unrelated')
  assert.equal((await relate(B, 'parent', null)).error, undefined, 'clearing the parent')
})

test('missing targets: unknown issue fails, only parent may omit the target', async () => {
  reset([row(A)])
  assert.equal((await relate(A, 'parent', MISSING)).error, 'issueNotFound')
  for (const kind of ['child', 'blocks', 'blockedBy', 'duplicate', 'related'] as const) {
    assert.equal((await relate(A, kind, null)).error, 'issueTargetRequired', kind)
  }
  assert.equal((await relate(A, 'parent', 'not-a-uuid')).error, 'issueRelationInvalid')
})

test('a deleted target is unavailable', async () => {
  reset([row(A), row(B, { deletedAt: new Date().toISOString() })])
  assert.equal((await relate(A, 'parent', B)).error, 'issueTargetUnavailable')
})

test('duplicate: direct and transitive duplicate cycles rejected; a plain duplicate is allowed', async () => {
  reset([row(A), row(B, { duplicateOfId: A }), row(C, { duplicateOfId: B }), row(D)])
  assert.equal((await relate(A, 'duplicate', B)).error, 'issueDuplicateCycle')
  assert.equal((await relate(A, 'duplicate', C)).error, 'issueDuplicateCycle')
  assert.equal((await relate(D, 'duplicate', C)).error, undefined)
})

test('blocking: direct, multi-level and mixed-direction cycles rejected', async () => {
  reset([row(A), row(B, { blockedByIds: [A] }), row(C, { blockedByIds: [B] }), row(D, { blockedByIds: [C] })])
  assert.equal((await relate(A, 'blockedBy', B)).error, 'issueBlockCycle', 'A<-B while B<-A')
  assert.equal((await relate(B, 'blocks', A)).error, 'issueBlockCycle', 'same edge via blocks')
  assert.equal((await relate(A, 'blockedBy', D)).error, 'issueBlockCycle', 'A->B->C->D->A')
  assert.equal((await relate(D, 'blocks', A)).error, 'issueBlockCycle')
})

test('blocking: non-cycles allowed, repeating an existing edge is idempotent', async () => {
  reset([row(A), row(B, { blockedByIds: [A] }), row(C), row(D)])
  assert.equal((await relate(C, 'blockedBy', A)).error, undefined, 'second issue blocked by A')
  assert.equal((await relate(C, 'blocks', D)).error, undefined, 'unrelated')
  assert.equal((await relate(B, 'blockedBy', A)).error, undefined, 'same edge again')
  assert.deepEqual(writes.find(w => w.id === B)?.metadata.blockedByIds, [A], 'no duplicate blocker id')
})

test('relation guards do not cross relation types', async () => {
  // A parent edge does not block a reverse blocking edge, and vice versa.
  reset([row(A), row(B, { parentId: A, blockedByIds: [A] })])
  assert.equal((await relate(A, 'blockedBy', B)).error, 'issueBlockCycle')
  assert.equal((await relate(A, 'duplicate', B)).error, undefined)
  reset([row(A), row(B, { blockedByIds: [A] })])
  assert.equal((await relate(A, 'parent', B)).error, undefined)
})

test('removal skips the cycle check even when adding the same edge would cycle', async () => {
  reset([row(A), row(B, { duplicateOfId: A })]) // A duplicate of B would close A->B->A
  assert.equal((await relate(A, 'duplicate', B, true)).error, undefined, 'duplicate removal')
  reset([row(A, { blockedByIds: [B, D] }), row(B, { blockedByIds: [A] }), row(D)]) // legacy cycle A<->B
  assert.equal((await relate(A, 'blockedBy', D, true)).error, undefined, 'blocking removal on cyclic data')
  assert.deepEqual(writes.find(w => w.id === A)?.metadata.blockedByIds, [B])
})

test('related: re-adding an existing link succeeds without duplicate ids', async () => {
  reset([row(A, { relatedIds: [B] }), row(B, { relatedIds: [A] })])
  assert.equal((await relate(A, 'related', B)).error, undefined)
  assert.deepEqual(writes.find(w => w.id === A)?.metadata.relatedIds, [B])
  assert.deepEqual(writes.find(w => w.id === B)?.metadata.relatedIds, [A])
})

test('cross-owner targets are rejected', async () => {
  reset([row(A), row(B, {}, { userId: OTHER_OWNER })])
  for (const kind of ['parent', 'blocks', 'related'] as const) {
    assert.equal((await relate(A, kind, B)).error, 'issueCrossOwner', kind)
  }
  assert.equal(writes.length, 0)
})

test('another workspace cannot be linked even for the same owner', async () => {
  reset([row(A), row(B, {}, { workspaceId: OTHER_WORKSPACE })])
  for (const kind of ['parent', 'blocks', 'related'] as const) assert.equal((await relate(A, kind, B)).error, 'issueTargetUnavailable', kind)
  assert.equal(writes.length, 0)
})

test('a stale revision is outdated', async () => {
  reset([row(A, {}, { revision: 2 }), row(B)])
  assert.equal((await relate(A, 'related', B)).error, 'issueOutdated')
  assert.equal((await relate(A, 'related', B, false, 2)).error, undefined, 'current revision passes')
})

test('active shared-workspace members need no legacy per-task invitation to edit relations', async () => {
  reset([row(A), row(B)])
  actor = MEMBER
  assert.equal((await relate(A, 'related', B)).error, undefined)
  assert.deepEqual(writes.map(write => write.id).sort(), [A, B])
})

test('legacy task invitations cannot bypass revoked workspace membership after entry lookup', async () => {
  reset([row(A), row(B)])
  actor = MEMBER
  members = [A, B].map(issueId => ({ issueId, userId: OWNER, memberId: MEMBER }))
  workspaceMembers.delete(MEMBER)
  assert.equal((await relate(A, 'related', B)).error, 'issueNotFound')
  assert.equal(writes.length, 0)
  assert.equal(workspaceLease, false)
})
