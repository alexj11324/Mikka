import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { observePoolCommits } from '../lib/db/commit-effects'
import { advanceIssueStatus } from '../lib/task-status-advance'
import { advanceTaskForStartedRun } from '../lib/task-status-run-start'
import { refreshPublishedPullRequest } from '../lib/github/publication-webhook'

const base = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true')
if (required) assert.ok(base, 'E2E_DATABASE_URL is required')
function guarded(url: string) {
  const u = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only')
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/)
  return u
}

// Decision 2026-11-13-1405: a task's status advances with its work, forward only, never over the person's own change.
test('a task status advances forward only, once, as a versioned system change, and keeps what the person set', { skip: !base, timeout: 120_000 }, async () => {
  const admin = guarded(base!)
  const name = `tsa_${randomUUID().replaceAll('-', '')}_e2e`
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 })
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`)
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString())
  const pool = new Pool({ connectionString: target.toString(), max: 2 })
  observePoolCommits(pool)
  try {
    const dir = new URL('../drizzle/', import.meta.url)
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'))
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','O','o@example.invalid',true,now(),now())`)
    const agentId = randomUUID()
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Coder','codex')`, [agentId])
    const workspaceId = await seedFixtureWorkspace(pool, 'owner')
    const content = (pullRequests: unknown[] = []) => JSON.stringify({ type: 'doc', attrs: { mikka: { pullRequests } }, content: [] })
    const task = async (status: string, pullRequests: unknown[] = []) => {
      const id = randomUUID()
      await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,'owner',$2,'Task',$3,$4,'normal')`, [id, workspaceId, content(pullRequests), status])
      return id
    }
    const read = async (id: string) => (await pool.query<{ status: string; revision: number }>('SELECT status, revision FROM issues WHERE id=$1', [id])).rows[0]
    const versions = async (id: string) => (await pool.query<{ actor_type: string; actor_id: string; status: string; revision: number }>('SELECT actor_type, actor_id, status, revision FROM issue_versions WHERE "issueId"=$1 ORDER BY revision', [id])).rows
    // What a person's edit writes (app/actions/issues.ts): the new revision as a version with the user actor.
    const personSets = async (id: string, status: string) => {
      const { rows: [saved] } = await pool.query(`UPDATE issues SET status=$2, revision=revision+1 WHERE id=$1 RETURNING "userId",revision,title,content,status,priority`, [id, status])
      await pool.query(`INSERT INTO issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'user','owner')`,
        [id, saved.userId, saved.revision, saved.title, saved.content, saved.status, saved.priority])
    }
    const now = async () => (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now

    // Forward, one step or several, recorded as the system's change.
    const open = await task('todo')
    assert.equal(await advanceIssueStatus(pool, { issueId: open, to: 'doing', since: null, source: 'run-started' }), true)
    assert.deepEqual(await read(open), { status: 'doing', revision: 2 })
    assert.deepEqual(await versions(open), [{ actor_type: 'system', actor_id: 'run-started', status: 'doing', revision: 2 }])
    // Idempotent: the same event again writes nothing.
    assert.equal(await advanceIssueStatus(pool, { issueId: open, to: 'doing', since: null, source: 'run-started' }), false)
    assert.deepEqual(await read(open), { status: 'doing', revision: 2 })
    assert.equal(await advanceIssueStatus(pool, { issueId: open, to: 'done', since: null, source: 'pull-request-merged' }), true, '进行中 can go straight to 已完成')
    // Never backwards: a late 「started」 or 「review」 leaves a finished task alone.
    for (const to of ['doing', 'review'] as const) assert.equal(await advanceIssueStatus(pool, { issueId: open, to, since: null, source: 'late' }), false)
    assert.equal((await read(open)).status, 'done')
    // 已取消 and 重复 are the person's last word.
    for (const closed of ['canceled', 'duplicate']) {
      const id = await task(closed)
      for (const to of ['doing', 'review', 'done'] as const) assert.equal(await advanceIssueStatus(pool, { issueId: id, to, since: null, source: 'late' }), false)
      assert.deepEqual(await read(id), { status: closed, revision: 1 })
    }

    // A status the person set after the work began is kept, even when it is behind the target.
    const held = await task('doing')
    const began = await now()
    await personSets(held, 'todo')
    assert.equal(await advanceIssueStatus(pool, { issueId: held, to: 'review', since: began, source: 'run-review' }), false)
    assert.equal((await read(held)).status, 'todo')
    // The same change made before this work began does not hold a later run back.
    assert.equal(await advanceIssueStatus(pool, { issueId: held, to: 'review', since: await now(), source: 'run-review' }), true)
    assert.equal((await read(held)).status, 'review')
    // A person's edit that leaves the status alone (a title, a label) is not a status change.
    const edited = await task('todo')
    const editedBegan = await now()
    await advanceIssueStatus(pool, { issueId: edited, to: 'doing', since: editedBegan, source: 'run-started' })
    await personSets(edited, 'doing')
    assert.equal(await advanceIssueStatus(pool, { issueId: edited, to: 'review', since: editedBegan, source: 'run-review' }), true)

    // Agent starts work → 进行中, only for a run that has started and has a task.
    const dispatched = await task('todo')
    const runId = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt) VALUES ($1,'owner',$2,$3,'queued','Fix it')`, [runId, dispatched, agentId])
    assert.equal(await advanceTaskForStartedRun(pool, runId), null, 'a queued run has not started')
    assert.equal((await read(dispatched)).status, 'todo')
    await pool.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now() WHERE id=$1`, [runId])
    assert.equal(await advanceTaskForStartedRun(pool, runId), dispatched)
    assert.equal((await read(dispatched)).status, 'doing')
    assert.equal(await advanceTaskForStartedRun(pool, runId), null, 'a second claim of the same task changes nothing')
    // The person moved the task back to 待办 after dispatching: a retry's start does not undo that.
    await personSets(dispatched, 'todo')
    await pool.query(`UPDATE agent_runs SET "startedAt"=now() WHERE id=$1`, [runId])
    assert.equal(await advanceTaskForStartedRun(pool, runId), null)
    assert.equal((await read(dispatched)).status, 'todo')
    const loose = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId",status,prompt,"startedAt") VALUES ($1,'owner',$2,'running','No task',now())`, [loose, agentId])
    assert.equal(await advanceTaskForStartedRun(pool, loose), null, 'a run with no task moves nothing')

    // Its PR merged → 已完成, through the signed GitHub webhook's writer; never while another PR is open.
    const url = 'https://github.com/o/r/pull/7', other = 'https://github.com/o/r/pull/8'
    const event = (number: number, merged: boolean) => ({ repository: { full_name: 'o/r' },
      pull_request: { number, html_url: `https://github.com/o/r/pull/${number}`, title: 'Fix', state: merged ? 'closed' : 'open', draft: false, merged_at: merged ? '2026-11-02T00:00:00Z' : null } })
    const delivered = await task('review', [{ url, state: 'open' }])
    const twoPrs = await task('review', [{ url: other, state: 'open' }, { url: 'https://github.com/o/r/pull/9', state: 'open' }])
    const [runA, runB] = [randomUUID(), randomUUID()]
    for (const [run, issue, pr] of [[runA, delivered, url], [runB, twoPrs, other]]) {
      await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt,"startedAt") VALUES ($1,'owner',$2,$3,'succeeded','Fix it',now())`, [run, issue, agentId])
      await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published',$3)`, [run, issue, JSON.stringify({ url: pr, state: 'open' })])
    }
    await refreshPublishedPullRequest('pull_request', event(7, false), pool)
    assert.equal((await read(delivered)).status, 'review', 'an open PR does not finish the task')
    await refreshPublishedPullRequest('pull_request', event(7, true), pool)
    assert.equal((await read(delivered)).status, 'done')
    assert.deepEqual((await versions(delivered)).at(-1), { actor_type: 'system', actor_id: 'pull-request-merged', status: 'done', revision: (await read(delivered)).revision })
    const settled = await read(delivered)
    await refreshPublishedPullRequest('pull_request', event(7, true), pool)
    assert.deepEqual(await read(delivered), settled, 'a redelivered merge writes nothing')
    await refreshPublishedPullRequest('pull_request', event(8, true), pool)
    assert.equal((await read(twoPrs)).status, 'review', 'another PR listed on the task is still open')
    // A task the person reopened after its work began stays where they put it when the PR merges.
    const reopened = await task('review', [{ url: 'https://github.com/o/r/pull/10', state: 'open' }])
    const runC = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt,"startedAt") VALUES ($1,'owner',$2,$3,'succeeded','Fix it',now())`, [runC, reopened, agentId])
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published',$3)`, [runC, reopened, JSON.stringify({ url: 'https://github.com/o/r/pull/10', state: 'open' })])
    await personSets(reopened, 'doing')
    await refreshPublishedPullRequest('pull_request', event(10, true), pool)
    assert.equal((await read(reopened)).status, 'doing')
  } finally {
    await dropTestDatabase(adminPool, name, pool)
    await adminPool.end()
  }
})
