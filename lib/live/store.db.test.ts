import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import type { LiveInvalidation } from './events'
import type { LiveScope } from './scope'
import { observePoolCommits } from '../db/commit-effects'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('the real Factory store schedules one invalidation only after its outer transaction commits', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  let onSchedule = () => {}
  const notification = mock.module('./notify', { namedExports: {
    scheduleLive: (work: () => Promise<void>) => { pending.push(work); onSchedule() },
    sendLiveInvalidations: async (scope: LiveScope, events: LiveInvalidation[]) => { sent.push({ scope, events }) },
  } })
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-live-test-secret'
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `factory_live_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 4 })
  observePoolCommits(pool)
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(dir)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(name, dir), 'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','live@example.invalid',true,now(),now())`)
    const workspaceId = await seedFixtureWorkspace(pool, 'owner')
    const { createFactoryStore } = await import('../factory/store')
    const store = createFactoryStore(pool, async (owner, issue, tx) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, owner])).rowCount === 1, null, {})
    async function input() {
      const issueId = randomUUID(), sourceEventId = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId") VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal',$2)`, [issueId, workspaceId])
      await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId])
      return { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Requested task', missingInformation: [], missingPermissions: [], needsSpec: false }
    }
    await t.test('route waits for the caller COMMIT; reads and idempotent replay send nothing', async () => {
      const request = await input(), tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        const routed = await store.route('owner', request, tx)
        assert.equal(pending.length, 0)
        assert.equal((await pool.query('SELECT id FROM factory_tasks WHERE id=$1', [routed.task.id])).rowCount, 0)
        await tx.query('COMMIT')
        assert.equal(pending.length, 2, 'Factory and project-map invalidations wait for commit; reads/replay add nothing')
        assert.equal((await pool.query('SELECT id FROM factory_tasks WHERE id=$1', [routed.task.id])).rowCount, 1)
        await store.read('owner', routed.task.id)
        await store.route('owner', request)
        assert.equal(pending.length, 2, 'Factory and project-map invalidations wait for commit; reads/replay add nothing')
      } finally { tx.release() }
    })
    await t.test('a route rolled back by its caller never schedules work', async () => {
      const request = await input(), tx = await pool.connect(), before = pending.length
      try {
        await tx.query('BEGIN')
        await store.route('owner', request, tx)
        await tx.query('ROLLBACK')
        assert.equal(pending.length, before)
        assert.equal((await pool.query('SELECT id FROM factory_tasks WHERE "issueId"=$1', [request.issueId])).rowCount, 0)
      } finally { tx.release() }
    })
    await t.test('a non-merge PR webhook refreshes the current Factory delivery after its update commits', async () => {
      const request = await input()
      const { task } = await store.route('owner', request)
      const [agentId, runId, candidateId, projectId] = Array.from({ length: 4 }, () => randomUUID())
      await pool.query(`INSERT INTO workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
        VALUES($1,'owner',$2,'Fixture','','','planned','none','','','','','[]',1)`, [projectId, workspaceId])
      await pool.query('INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId") VALUES ($1,$2,$3)', [task.issueId, projectId, workspaceId])
      await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES ($1,'owner','Fixture','codex')`, [agentId])
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt) VALUES ($1,'owner',$2,$3,'succeeded','Fixture')`, [runId, task.issueId, agentId])
      const url = 'https://github.com/fixture/repo/pull/7'
      await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/fixture/repo','fixture/repo','published',$3)`,
        [runId, task.issueId, JSON.stringify({ url, state: 'open', title: 'Before' })])
      await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'fixture/repo','fixture','fixture',$4)`, [candidateId, task.id, 'a'.repeat(40), runId])
      await pool.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [task.id, candidateId])
      const { refreshPublishedPullRequest } = await import('../github/publication-webhook')
      const { factoryTaskDetail } = await import('../factory/task-detail')
      const reader = await pool.connect()
      let visibility: Promise<void> | undefined
      const requestScope = await import('../db/request-scope')
      const workspace = await import('../workspace-db')
      const databases = [
        mock.module(new URL('../db/request-scope.ts', import.meta.url).href, { namedExports: { ...requestScope, pool } }),
        mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { ...workspace, workspacePool: pool } }),
      ]
      pending.length = 0 // Ignore preceding route notifications, which have their own assertions above.
      try {
        for (const state of ['closed', 'draft', 'open']) {
          const title = `Updated ${state}`
          onSchedule = () => {
            visibility ??= factoryTaskDetail(reader, { ...task, candidateId }).then(detail => {
              assert.deepEqual(detail.delivery.pullRequest, { url, state, title })
            })
          }
          await refreshPublishedPullRequest('pull_request', { repository: { full_name: 'fixture/repo' }, pull_request: {
            number: 7, html_url: url, title, state: state === 'closed' ? 'closed' : 'open', draft: state === 'draft', merged_at: null,
          } }, pool)
          assert.equal(pending.length, 4)
          await visibility
          visibility = undefined
          for (const work of pending.splice(0)) await work()
          const changes = sent.splice(0).flatMap(({ scope, events }) => {
            assert.deepEqual(scope, { ownerId: 'owner', workspaceId })
            return events.map(event => [event.kind, event.id])
          })
          assert.deepEqual(changes.sort(), [
            ['factory_task', task.id], ['factory_issue', task.issueId], ['project_map', projectId],
            ['pull_request_status', task.issueId], ['thread_list', workspaceId],
          ].sort(), 'only the current Factory, linked project, PR badge and owner conversation list refresh')
        }
        await refreshPublishedPullRequest('pull_request', { repository: { full_name: 'other/repo' }, pull_request: {
          number: 7, html_url: url, title: 'Mismatched repository', state: 'closed', draft: false, merged_at: null,
        } }, pool)
        assert.equal(pending.length, 0, 'an invalid webhook target sends nothing')
      } finally {
        onSchedule = () => {}
        await visibility?.catch(() => {})
        for (const database of databases.reverse()) database.restore()
        reader.release()
      }
    })
  } finally {
    notification.restore()
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
