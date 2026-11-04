// The project map's reads (R-83) against a real database: only issues the viewer
// can open are drawn, Artifacts are the viewer's own, and another person's
// project is not found. Threads and the Factory are stood in for: their own
// suites cover their access rules, and the map passes their answers through.
// Only the disposable mikka_e2e service may run this fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'

let hasDb = false
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  hasDb = isE2eTarget(target.href)
    && process.env.MIKKA_DATABASE_URL === process.env.E2E_DATABASE_URL
    && process.env.DATABASE_URL === process.env.E2E_DATABASE_URL
} catch { /* no eligible ephemeral service */ }
if (!hasDb && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 but the isolated database is not configured')

test('the map draws only issues the viewer can open, with their own Artifacts', { skip: !hasDb && 'no isolated database' }, async () => {
  const { eq, inArray, sql } = await import('drizzle-orm')
  const { db } = await import('../db')
  const { artifacts, issues, users } = await import('../db/schema')
  const { projectDb, projects } = await import('../db/projects')
  const { actAs } = await import('../acting-user')
  const { readProjectMap, readProjectMapNode } = await import('./server')
  const owner = `map-owner-${randomUUID()}`
  const stranger = `map-other-${randomUUID()}`
  const [start, next, foreign, deleted] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const [ownArtifact, foreignArtifact] = [randomUUID(), randomUUID()]
  const projectId = randomUUID()
  const doc = (mikka: Record<string, unknown>, text = '') => ({ type: 'doc', attrs: { mikka }, content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] })
  const asked: string[] = []
  const sources = {
    listThreads: async (issueId: string) => { asked.push(issueId); return [] },
    listFactoryTasks: async () => ({ tasks: [] }),
    readFactoryTask: async () => ({}),
    readLedger: async () => ({ approvals: [], rejections: [], merges: [] }),
  }
  for (const id of [owner, stranger]) await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${id}, 'Map Test', ${id + '@example.test'}, false, now(), now())`)
  try {
    await db.insert(issues).values([
      { id: start, userId: owner, title: '明确研究问题', status: 'done', priority: 'normal', content: doc({}, '绿地面积和形状，哪个对降温影响更大') },
      { id: next, userId: owner, title: '随机森林基线', status: 'canceled', priority: 'normal', content: doc({ parentId: start }) },
      { id: foreign, userId: stranger, title: 'not yours', status: 'todo', priority: 'normal', content: doc({}) },
      { id: deleted, userId: owner, title: 'deleted', status: 'todo', priority: 'normal', content: doc({ deletedAt: new Date().toISOString() }) },
    ])
    await projectDb.insert(projects).values({ id: projectId, userId: owner, name: '城市绿地降温研究', summary: '', description: '', status: 'started', priority: 'none', lead: '', team: '', startDate: '', targetDate: '', issueIds: [start, next, foreign, deleted], revision: 1 })
    await db.insert(artifacts).values([
      { id: ownArtifact, userId: owner, kind: 'markdown', title: '研究提纲', issueId: start },
      { id: foreignArtifact, userId: stranger, kind: 'markdown', title: 'someone else', issueId: start },
    ])

    const map = await actAs(owner, () => readProjectMap(owner, projectId, undefined, sources))
    assert.deepEqual(map.nodes.map(node => node.id).sort(), [start, next].sort(), 'an issue the viewer cannot open, or a deleted one, is not drawn')
    assert.deepEqual(asked.sort(), [start, next].sort(), 'threads are only read for drawn issues')
    const first = map.nodes.find(node => node.id === start)!
    assert.deepEqual(first.artifacts.map(item => item.id), [ownArtifact], "another person's Artifact never appears")
    assert.equal(map.nodes.find(node => node.id === next)!.parentId, start)

    const node = await actAs(owner, () => readProjectMapNode(owner, projectId, undefined, start))
    assert.equal(node.description, '绿地面积和形状，哪个对降温影响更大')
    await assert.rejects(actAs(owner, () => readProjectMapNode(owner, projectId, undefined, foreign)), (error: { code?: string }) => error.code === 'issueNotFound')
    await assert.rejects(actAs(stranger, () => readProjectMap(stranger, projectId, undefined, sources)), (error: { code?: string }) => error.code === 'projectNotFound', "another person's project is not found")
  } finally {
    await db.delete(artifacts).where(inArray(artifacts.id, [ownArtifact, foreignArtifact]))
    await projectDb.delete(projects).where(eq(projects.id, projectId))
    await db.delete(issues).where(inArray(issues.id, [start, next, foreign, deleted]))
    await db.delete(users).where(inArray(users.id, [owner, stranger]))
  }
})
