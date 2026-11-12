import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { refreshPublishedPullRequest } from './publication-webhook'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { readFactoryFlow } from '../factory/public-flow'
import type { FactoryTask } from '../factory/store'
import type { CoordinatorEventInput } from '../coordinator-events'
import { afterDatabaseCommit, captureDatabaseQuery, observePoolCommits } from '../db/commit-effects'

const base = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true')
if (required) assert.ok(base, 'E2E_DATABASE_URL is required')
function guarded(url: string) {
  const u = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only')
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/)
  return u
}

const url = 'https://github.com/o/r/pull/7'
const other = 'https://github.com/o/r/pull/8'
const event = (lines: { additions?: number; deletions?: number }, state: 'open' | 'closed' = 'open', merged = false) => ({
  repository: { full_name: 'o/r' },
  pull_request: { number: 7, html_url: url, title: 'Fix the login page', state, draft: false, merged_at: merged ? '2026-11-02T00:00:00Z' : null, ...lines },
})
const content = (pullRequests: unknown[]) => JSON.stringify({ type: 'doc', attrs: { mikka: { pullRequests } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body stays' }] }] })

test('a PR webhook records its line counts on the delivery and on the tasks it belongs to, as a versioned system change', { skip: !base, timeout: 120_000 }, async t => {
  const admin = guarded(base!)
  const name = `prw_${randomUUID().replaceAll('-', '')}_e2e`
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 })
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`)
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString())
  const pool = new Pool({ connectionString: target.toString(), max: 2 })
  // The race clients are real transaction executors, just like the application
  // pool. Live invalidations must observe their COMMIT rather than a raw client.
  observePoolCommits(pool)
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'))
    const [agentId, runId, delivered, unrelated] = Array.from({ length: 4 }, () => randomUUID())
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','O','o@example.invalid',true,now(),now())`)
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Coder','codex')`, [agentId])
    const workspaceId = await seedFixtureWorkspace(pool, 'owner')
    // The delivered task lists this PR and another; an unrelated task names the same URL but has no delivery for it.
    await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,'owner',$5,'Delivered',$2,'review','normal'),($3,'owner',$5,'Unrelated',$4,'todo','normal')`,
      [delivered, content([{ url: other, state: 'open' }, { url, state: 'open', title: 'Fix the login page' }]), unrelated, content([{ url, state: 'open' }]), workspaceId])
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt) VALUES ($1,'owner',$2,$3,'succeeded','Fix it')`, [runId, delivered, agentId])
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published',$3)`,
      [runId, delivered, JSON.stringify({ url, state: 'open' })])
    const task = async (id: string) => (await pool.query<{ content: { attrs: { mikka: { pullRequests: Record<string, unknown>[] } }; content: unknown[] }; revision: number }>('SELECT content, revision FROM issues WHERE id=$1', [id])).rows[0]
    const versions = async (id: string) => (await pool.query<{ actor_type: string; actor_id: string; revision: number }>('SELECT actor_type, actor_id, revision FROM issue_versions WHERE "issueId"=$1 ORDER BY revision', [id])).rows

    await refreshPublishedPullRequest('pull_request', event({ additions: 18, deletions: 4 }, 'closed', true), pool)
    const saved = await task(delivered)
    assert.deepEqual(saved.content.attrs.mikka.pullRequests, [
      { url: other, state: 'open' },
      // Only the counts change; the task's own PR state is not this sync's to move.
      { url, state: 'open', title: 'Fix the login page', additions: 18, deletions: 4 },
    ])
    assert.deepEqual(saved.content.content, [{ type: 'paragraph', content: [{ type: 'text', text: 'Body stays' }] }])
    assert.equal(saved.revision, 2)
    assert.deepEqual(await versions(delivered), [{ actor_type: 'system', actor_id: 'github-webhook', revision: 2 }])
    const { rows: [publication] } = await pool.query('SELECT "pullRequest" FROM run_publications WHERE "runId"=$1', [runId])
    assert.deepEqual(publication.pullRequest, { url, state: 'merged', title: 'Fix the login page', additions: 18, deletions: 4 })
    // A task with no delivery for this PR is never touched.
    assert.equal((await task(unrelated)).revision, 1)
    assert.deepEqual((await task(unrelated)).content.attrs.mikka.pullRequests, [{ url, state: 'open' }])

    // The same counts again, or an event without counts, write nothing new.
    await refreshPublishedPullRequest('pull_request', event({ additions: 18, deletions: 4 }), pool)
    await refreshPublishedPullRequest('pull_request', event({}), pool)
    await refreshPublishedPullRequest('pull_request', event({ additions: 18 }), pool)
    assert.equal((await task(delivered)).revision, 2)
    assert.equal((await versions(delivered)).length, 1)

    // New counts are a new version.
    await refreshPublishedPullRequest('pull_request', event({ additions: 25, deletions: 6 }), pool)
    assert.deepEqual((await task(delivered)).content.attrs.mikka.pullRequests[1], { url, state: 'open', title: 'Fix the login page', additions: 25, deletions: 6 })
    assert.deepEqual((await versions(delivered)).map(row => row.revision), [2, 3])

    const taskId = randomUUID(), attemptId = randomUUID(), candidateId = randomUUID(), headSha = 'a'.repeat(40), newHead = 'b'.repeat(40)
    const fixture = await pool.connect()
    try {
      await fixture.query('BEGIN')
      await fixture.query(`INSERT INTO factory_tasks(id,"userId","workspaceId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
        VALUES($1,'owner',$2,$3,$4,'{}','approval','pending',$5,'fixture')`, [taskId, workspaceId, delivered, randomUUID(), attemptId])
      await fixture.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason)
        VALUES($1,$2,'approval',1,1,'pending',$3,'fixture')`, [attemptId, taskId, runId])
      await fixture.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId")
        VALUES($1,$2,$3,'o/r','fixture','fixture',$4)`, [candidateId, taskId, headSha, runId])
      await fixture.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [taskId, candidateId])
      await fixture.query('COMMIT')
    } catch (error) { await fixture.query('ROLLBACK'); throw error } finally { fixture.release() }
    const flowTask = { id: taskId, userId: 'owner', issueId: delivered, botId: null, revision: 1, stage: 'approval', status: 'pending', candidateId, attemptId } as FactoryTask
    const flow = () => readFactoryFlow(pool, flowTask)
    const at = '2026-11-09T14:00:00.000Z'
    await pool.query(`UPDATE run_publications SET branch='mikka/mik-1',"pullRequest"="pullRequest"||$2::jsonb WHERE "runId"=$1`, [runId, JSON.stringify({ headSha, changedFiles: 2,
      reviewChecks: { headSha, complete: true, updatedAt: at, entries: {} } })])
    const snapshot = () => pool.query('SELECT "pullRequest","updatedAt" FROM run_publications WHERE "runId"=$1', [runId]).then(r => r.rows[0])
    const check = (id: number, name: string, status = 'completed', conclusion: string | null = 'success', sha = headSha) => ({ action: status === 'completed' ? 'completed' : 'created',
      repository: { full_name: 'o/r' }, check_run: { id, name, head_sha: sha, app: { id: 1 }, check_suite: { id: 100 }, status, conclusion, started_at: at, completed_at: status === 'completed' ? '2026-11-09T14:01:00.000Z' : null } })
    await Promise.all([
      refreshPublishedPullRequest('check_run', check(1, 'build'), pool),
      refreshPublishedPullRequest('check_run', check(2, 'tests', 'queued', null), pool),
      refreshPublishedPullRequest('status', { repository: { full_name: 'o/r' }, id: 3, context: 'deploy', sha: headSha, state: 'failure', updated_at: at }, pool),
    ])
    assert.deepEqual((await flow()).review?.summary, { branch: 'mikka/mik-1', additions: 25, deletions: 6, changedFiles: 2, headSha,
      checks: { passed: 1, failed: 1, pending: 1, skipped: 0 }, checksUpdatedAt: '2026-11-09T14:01:00.000Z' })
    const beforeReplay = await snapshot()
    await refreshPublishedPullRequest('check_run', check(1, 'build'), pool)
    await refreshPublishedPullRequest('check_run', check(1, 'build', 'queued', null), pool)
    await refreshPublishedPullRequest('check_run', { ...check(4, 'other'), repository: { full_name: 'foreign/r' } }, pool)
    await refreshPublishedPullRequest('check_run', check(5, 'old-head', 'completed', 'success', newHead), pool)
    assert.deepEqual(await snapshot(), beforeReplay, 'duplicates, stale states, other repositories and heads write nothing')
    await refreshPublishedPullRequest('check_run', check(10, 'build', 'queued', null), pool)
    assert.deepEqual((await flow()).review?.summary?.checks, { passed: 0, failed: 1, pending: 2, skipped: 0 }, 'a newer rerun replaces the prior green check')
    await refreshPublishedPullRequest('check_run', check(1, 'build'), pool)
    assert.deepEqual((await flow()).review?.summary?.checks, { passed: 0, failed: 1, pending: 2, skipped: 0 })

    const update = { ...event({}), action: 'synchronize', before: headSha, after: newHead,
      pull_request: { ...event({}).pull_request, head: { sha: newHead, ref: 'mikka/mik-2' }, updated_at: '2026-11-09T15:00:00Z' } }
    await refreshPublishedPullRequest('pull_request', update, pool)
    assert.deepEqual((await flow()).review?.summary, { branch: 'mikka/mik-2', headSha: newHead, additions: null, deletions: null, changedFiles: null, checks: null, checksUpdatedAt: null })
    const beforeOldEvent = (await task(delivered)).revision
    await refreshPublishedPullRequest('pull_request', { ...update, action: 'edited', pull_request: { ...update.pull_request, additions: 999, deletions: 999,
      head: { sha: headSha, ref: 'mikka/old' }, updated_at: '2026-11-09T14:00:00Z' } }, pool)
    assert.equal((await flow()).review?.summary?.headSha, newHead, 'an older PR event cannot restore the old head')
    assert.equal((await task(delivered)).revision, beforeOldEvent, 'an older event cannot rewrite the task line counts either')
    for (const action of ['edited', 'synchronize']) await refreshPublishedPullRequest('pull_request', { ...update, action, before: 'c'.repeat(40), after: headSha,
      pull_request: { ...update.pull_request, head: { sha: headSha, ref: 'mikka/older' } } }, pool)
    assert.equal((await flow()).review?.summary?.headSha, newHead, 'same-second delayed deliveries cannot reverse an observed head transition')
    await refreshPublishedPullRequest('check_run', check(20, 'only-one-observed', 'completed', 'success', newHead), pool)
    assert.equal((await flow()).review?.summary?.checks, null, 'a partial webhook cache never claims a complete checks total')

    const change = (before: string, after: string, updated_at: string, additions: number) => ({ ...event({ additions, deletions: 8 }),
      action: 'synchronize', before, after, pull_request: { ...event({ additions, deletions: 8 }).pull_request,
        head: { sha: after, ref: 'mikka/mik-2' }, changed_files: 3, updated_at } })
    // Fix the interleaving with a real row lock: the old event's initial
    // snapshot qualifies, then it waits while the lock owner commits a newer
    // head and task counts. Admission must be re-evaluated after that wait.
    const beforeRace = await task(delivered), lock = await pool.connect(), waiting = await pool.connect()
    let oldEvent: Promise<void> | undefined
    let committed = 0
    try {
      const pid = (await waiting.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await lock.query('BEGIN')
      afterDatabaseCommit(lock, 'publication-race-fixture', () => { committed++ })
      assert.equal(committed, 0, 'a webhook transaction cannot notify before COMMIT')
      await lock.query('SELECT "runId" FROM run_publications WHERE "runId"=$1 FOR UPDATE', [runId])
      oldEvent = refreshPublishedPullRequest('pull_request', change(newHead, 'c'.repeat(40), '2026-11-09T16:00:00Z', 50), waiting)
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = Boolean((await adminPool.query(`SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [pid])).rowCount)
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(blocked, true, 'the stale webhook must actually be waiting for the publication row')
      await refreshPublishedPullRequest('pull_request', change(newHead, 'd'.repeat(40), '2026-11-09T17:00:00Z', 80), lock)
      assert.equal(committed, 0)
      await lock.query('COMMIT')
      assert.equal(committed, 1, 'the real transaction executor releases its commit effects once')
      await oldEvent
    } finally {
      await lock.query('ROLLBACK')
      await oldEvent?.catch(() => {})
      waiting.release(); lock.release()
    }
    assert.equal((await snapshot()).pullRequest.headSha, 'd'.repeat(40))
    assert.equal((await snapshot()).pullRequest.additions, 80)
    assert.equal((await task(delivered)).content.attrs.mikka.pullRequests[1].additions, 80)
    assert.equal((await task(delivered)).revision, beforeRace.revision + 1, 'a rejected stale event cannot write a task version')

    // A second race exists between the metadata UPDATE and the separate task
    // version statement. Let the newer delivery finish in that exact gap.
    let reached!: () => void, resume!: () => void
    const reachedCounts = new Promise<void>(resolve => { reached = resolve })
    const resumeCounts = new Promise<void>(resolve => { resume = resolve })
    const retained = captureDatabaseQuery(pool)
    const pausedDatabase = { ...retained, query: async (...args: unknown[]) => {
      if (String(args[0]).includes('WITH delivered AS')) { reached(); await resumeCounts }
      return Reflect.apply(retained.query, retained, args)
    } } as Pick<Pool, 'query'>
    afterDatabaseCommit(pausedDatabase, 'publication-autocommit-fixture', () => { committed++ })
    assert.equal(committed, 2, 'a retained query keeps its underlying autocommit executor')
    const delayed = refreshPublishedPullRequest('pull_request', change('d'.repeat(40), 'e'.repeat(40), '2026-11-09T18:00:00Z', 85), pausedDatabase)
    try {
      await Promise.race([reachedCounts, delayed.then(() => { assert.fail('the old event must pause before task counts') })])
      await refreshPublishedPullRequest('pull_request', change('e'.repeat(40), 'f'.repeat(40), '2026-11-09T19:00:00Z', 90), pool)
      const currentPublication = await snapshot(), currentTask = await task(delivered)
      resume(); await delayed
      assert.deepEqual(await snapshot(), currentPublication)
      assert.deepEqual(await task(delivered), currentTask, 'the old second statement cannot overwrite the newer task counts or revision')
    } finally { resume(); await delayed.catch(() => {}) }
    await pool.query('UPDATE run_publications SET "pullRequest"=NULL WHERE "runId"=$1', [runId])
    assert.equal((await flow()).review, null, 'a task without a PR returns empty review metadata')

    // One matching delivery belongs to this owner, workspace, issue and run.
    const { recordWorkflowResult } = await import('./workflow-result-store')
    const ciBot = randomUUID(), ciRun = randomUUID()
    await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'CI fixture')`, [ciBot, workspaceId])
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","workspaceId","botId","agentId",status,prompt)
      VALUES($1,'owner',$2,$3,$4,$5,'succeeded','CI fixture')`, [ciRun, delivered, workspaceId, ciBot, agentId])
    await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",branch,status,"pullRequest")
      VALUES($1,'owner',$2,'https://github.com/o/r','v2/github.com/o/r','mikka/ci-7','published',$3)`,
      [ciRun, delivered, JSON.stringify({ url, headSha: newHead })])
    await pool.query(`INSERT INTO github_repository_installations("userId","remoteKey","githubAccountId","installationId","repositoryId")
      VALUES('owner','v2/github.com/o/r','12',11,22)`)
    const target = { runId: ciRun, issueId: delivered, ownerId: 'owner', workspaceId, botId: ciBot, previous: null }
    const result = { version: 1 as const, deliveryId: 'first-delivery', installationId: 11, repositoryId: 22, repository: 'o/r',
      workflowId: 33, workflowRunId: 44, attempt: 1, headSha: newHead, branch: 'mikka/ci-7', conclusion: 'failure' as const }
    for (const wrong of [{ installationId: 12 },{ repositoryId: 23 },{ repository: 'other/r' },{ branch: 'mikka/ci-8' },{ headSha }])
      assert.equal(await recordWorkflowResult(pool, target, { ...result, ...wrong }), null)
    for (const wrong of [{ownerId: 'other'}, {workspaceId: randomUUID()}, {botId: randomUUID()}, {runId: randomUUID()}])
      assert.equal(await recordWorkflowResult(pool, { ...target, ...wrong }, result), null)
    const [idA, idB] = await Promise.all([recordWorkflowResult(pool, target, result), recordWorkflowResult(pool, target, { ...result, deliveryId: 'redelivery' })])
    assert.ok(idA)
    assert.equal(idB, idA, 'redelivery while Eve acknowledgement is pending reuses the same event')
    assert.equal(await recordWorkflowResult(pool, target, { ...result, conclusion: 'success' }), null, 'conflicting outcome for identical attempt')
    await pool.query('UPDATE coordinator_events SET "deliveredAt"=now() WHERE id=$1', [idA])
    assert.equal(await recordWorkflowResult(pool, target, result), null)
    const secondId = await recordWorkflowResult(pool, target, { ...result, attempt: 2, conclusion: 'success' })
    assert.ok(secondId && secondId !== idA)
    assert.equal(await recordWorkflowResult(pool, target, result), null, 'old attempt cannot overwrite the later conclusion')
    await t.test('a completed GitHub check suite selects the ended publication with the matching PR head', async () => {
      const { wakeLinkedCiSuite } = await import('./ci-suite-wake')
      const sent: CoordinatorEventInput[] = []
      const dependencies = {
        query: (statement: string, params: unknown[]) => pool.query(statement, params),
        send: async (event: CoordinatorEventInput) => { sent.push(event) },
      }
      const suite = { installationId: 11, repositoryId: 22, repository: 'o/r', suiteId: 97,
        headSha: '9'.repeat(40), conclusion: 'failure', numbers: [7], heads: { '7': newHead } }
      await pool.query(`UPDATE run_publications SET "pullRequest"="pullRequest" || '{"state":"open"}'::jsonb WHERE "runId"=$1`, [ciRun])
      assert.equal(await wakeLinkedCiSuite(suite, dependencies), 0, 'unfinished runs stay asleep')
      await pool.query('UPDATE agent_runs SET "finishedAt"=now() WHERE id=$1', [ciRun])
      assert.equal(await wakeLinkedCiSuite({ ...suite, heads: { '7': headSha } }, dependencies), 0, 'stale PR head')
      assert.equal(await wakeLinkedCiSuite({ ...suite, repository: 'another/repository' }, dependencies), 0, 'foreign repository')
      assert.equal(await wakeLinkedCiSuite(suite, dependencies), 1)
      assert.deepEqual(sent.map(event => [
        event.userId, event.botId, event.issueId, event.runId, event.kind, event.dedupeKey, event.payload.source,
      ]), [['owner', ciBot, delivered, ciRun, 'run_report',
        `github_ci_suite:${ciRun}:o/r:${suite.headSha}:97:failure`, 'github_ci_suite']])
    })
    const { rows: [counts] } = await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1 AND "botId"=$2`, [ciRun, ciBot])
    assert.equal(counts.n, 2)
    await pool.query('DELETE FROM github_repository_installations WHERE "userId"=$1 AND "remoteKey"=$2', ['owner','v2/github.com/o/r'])
    assert.equal(await recordWorkflowResult(pool, target, { ...result, attempt: 3 }), null, 'revocation after receipt suppresses a queued result')
  } finally {
    // Only after every client of this test's own database has closed (#913).
    await dropTestDatabase(adminPool, name, pool)
    await adminPool.end()
  }
})
