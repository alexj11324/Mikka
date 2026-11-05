import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { projects } from '../db/project-schema'

// Loading the decoder must not open either authority database.
mock.module(new URL('../db/projects.ts', import.meta.url).href, { namedExports: { projects, projectDb: {} } })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { db: {} } })
mock.module(new URL('../issue-visibility.ts', import.meta.url).href, { namedExports: { issueVisibility: () => { throw new Error('Unexpected database read') } } })
mock.module(new URL('../team-access.ts', import.meta.url).href, { namedExports: { lockTeamRelations: () => { throw new Error('Unexpected database lock') } } })
const scopeModule = import('./scope')

const workspace = 'a0000000-0000-4000-8000-000000000001'
const foreign = 'b0000000-0000-4000-8000-000000000002'
const issue = 'c0000000-0000-4000-8000-000000000003'
const conflict = { code: 'PROJECT_SCOPE_CONFLICT', status: 409 }

test('compact scope links preserve raw duplicates, order, foreign links and denied team pairs', async () => {
  const { decodeProjectReadLinks } = await scopeModule
  const result = decodeProjectReadLinks(workspace, [0, foreign, 0], [
    [issue, 0, 1], [issue, foreign, 0], [issue, 0, 0], [issue, 0, 1],
  ])
  assert.deepEqual(result, {
    links: [{ workspaceId: workspace }, { workspaceId: foreign }, { workspaceId: workspace }],
    issueLinks: [
      { issueId: issue, workspaceId: workspace, allowed: true },
      { issueId: issue, workspaceId: foreign, allowed: false },
      { issueId: issue, workspaceId: workspace, allowed: false },
      { issueId: issue, workspaceId: workspace, allowed: true },
    ],
  })
  assert.deepEqual(decodeProjectReadLinks(workspace, [], []), { links: [], issueLinks: [] })
})

test('the 101st raw link rejects scope even when all links are duplicates', async () => {
  const { decodeProjectReadLinks } = await scopeModule
  assert.equal(decodeProjectReadLinks(workspace, Array(100).fill(0), []).links.length, 100)
  assert.equal(decodeProjectReadLinks(workspace, [], Array(100).fill([issue, 0, 0])).issueLinks.length, 100)
  assert.throws(() => decodeProjectReadLinks(workspace, Array(101).fill(0), []), conflict)
  assert.throws(() => decodeProjectReadLinks(workspace, [], Array(101).fill([issue, 0, 0])), conflict)
})

test('malformed compact rows cannot become authorization facts', async () => {
  const { decodeProjectReadLinks } = await scopeModule
  for (const links of [null, {}, [1], [-1], [null], [false], ['0'], ['invalid-workspace']])
    assert.throws(() => decodeProjectReadLinks(workspace, links, []), conflict)
  for (const issueLinks of [null, {}, [null], [{}], [[issue, 0]], [[issue, 0, true, 'extra']],
    [[issue, 0, 'false']], [[issue, 0, true]], [[issue, 1, 1]], [[issue, foreign, 1]],
    [['invalid-issue', 0, true]], [[0, 0, true]], [[null, 0, true]]])
    assert.throws(() => decodeProjectReadLinks(workspace, [], issueLinks), conflict)
})

test('the current workspace code is request-local and keeps PostgreSQL UUID spelling', async () => {
  const { decodeProjectReadLinks } = await scopeModule
  assert.equal(decodeProjectReadLinks(workspace, [0], []).links[0].workspaceId, workspace)
  assert.equal(decodeProjectReadLinks(foreign, [0], []).links[0].workspaceId, foreign)
  assert.equal(decodeProjectReadLinks(workspace.toUpperCase(), [0], []).links[0].workspaceId, workspace)
  // PostgreSQL UUIDs need not pass the candidate UUID version check; retain
  // these raw rows so the later candidate filter remains the authority.
  const rawIssue = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  assert.equal(decodeProjectReadLinks(workspace, [], [[rawIssue, foreign, 0]]).issueLinks[0].issueId, rawIssue)
})

test('one hundred same-workspace scope links use less than half the original JSON transport', async () => {
  const { decodeProjectReadLinks } = await scopeModule
  const original = {
    links: [{ workspaceId: workspace }],
    issueLinks: Array.from({ length: 100 }, (_, index) => ({
      issueId: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, workspaceId: workspace, allowed: true,
    })),
  }
  const compact = { links: [0], issueLinks: original.issueLinks.map(link => [link.issueId, 0, Number(link.allowed)]) }
  assert.deepEqual(decodeProjectReadLinks(workspace, compact.links, compact.issueLinks), original)
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(original)) / 2)
})
