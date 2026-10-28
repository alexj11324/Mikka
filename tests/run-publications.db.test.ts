import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { RunCompleteRequest } from '@mikka/protocol/run'
import type { PublishedPullRequest } from '../lib/run-publication-result'
import type { openRunPullRequest } from '../lib/github/run-pull-request'

const connection = process.env.E2E_DATABASE_URL
const enabled = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && Boolean(connection)
if (connection) {
  if (!enabled) throw new Error('Run publication DB tests require GitHub Actions ephemeral PG17')
  const target = new URL(connection)
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || target.port !== '5432' || target.pathname !== '/mikka_e2e' || target.search || target.hash) throw new Error('Run publication DB tests require the isolated loopback mikka_e2e service')
  if (process.env.MIKKA_DATABASE_URL !== connection || process.env.DATABASE_URL !== connection || (process.env.ORVILO_DATABASE_URL && process.env.ORVILO_DATABASE_URL !== connection)) throw new Error('All publication test database paths must use the ephemeral E2E_DATABASE_URL')
}
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Run publication DB tests cannot skip in required CI')

type Fixture = {
  userId: string; deviceId: string; agentId: string; repoId: string; issueId: string; runId: string
  remoteUrl: string; remoteKey: string; identifier: string; branch: string; githubAccountId: string
}
type OpenPullRequest = typeof openRunPullRequest

function completion(fixture: Fixture, summary = 'Verified redirect fix'): RunCompleteRequest {
  return {
    stopReason: 'submitted',
    report: {
      summary, filesChanged: ['src/redirect.ts'], verify: { status: 'passed', command: 'node --test', output: '1 test passed' },
      openQuestions: [], nextStep: null,
      publish: { branch: fixture.branch, commit: 'a'.repeat(40), pushed: true, remote: 'origin' },
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('run result publication commits one owner-scoped result through retries and races', { skip: !enabled, timeout: 90_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { prepareRunPublication, persistRunCompletion, publishRunResult } = await import('../lib/run-publications')
  const { PublicationError } = await import('../lib/run-publication-result')
  const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
  const fixtures: Fixture[] = []
  let githubId = 800_000

  const assignment = (fixture: Fixture) => ({ id: fixture.runId, userId: fixture.userId, issueId: fixture.issueId, baseBranch: null })
  const prFor = (fixture: Fixture, number = 77): PublishedPullRequest => ({ url: `https://${fixture.remoteKey}/pull/${number}`, state: 'open' })
  const counts = async (fixture: Fixture) => {
    const result = await pool.query<{ versions: string; events: string }>(`select
      (select count(*) from issue_versions where "issueId"=$1) as versions,
      (select count(*) from coordinator_events where "runId"=$2 and kind='run_finished') as events`, [fixture.issueId, fixture.runId])
    return { versions: Number(result.rows[0].versions), events: Number(result.rows[0].events) }
  }
  const receipt = async (fixture: Fixture) => (await pool.query('select * from run_publications where "runId"=$1', [fixture.runId])).rows[0]
  const task = async (fixture: Fixture) => (await pool.query('select * from issues where id=$1', [fixture.issueId])).rows[0]
  const event = async (fixture: Fixture) => (await pool.query('select * from coordinator_events where "runId"=$1 and kind=\'run_finished\'', [fixture.runId])).rows[0]
  const approval = async (fixture: Fixture, approved: boolean, includeHumanReceipt = true) => {
    const push = { approved, remote: 'origin', ...(includeHumanReceipt ? { approvedByUserId: fixture.userId, approvedAt: new Date().toISOString() } : {}) }
    await pool.query(`insert into repository_settings ("userId","remoteKey",push) values ($1,$2,$3)
      on conflict ("userId","remoteKey") do update set push=excluded.push,"updatedAt"=now()`, [fixture.userId, fixture.remoteKey, JSON.stringify(push)])
  }
  const fixture = async (options: { approved?: boolean; prefix?: string; number?: number; remoteKey?: string } = {}) => {
    const seed = randomUUID()
    const prefix = options.prefix ?? 'TEST'
    const number = options.number ?? 1
    const remoteKey = options.remoteKey ?? `github.com/mikka-ci/repo-${seed}`
    const row: Fixture = {
      userId: `publication-${seed}`, deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), issueId: randomUUID(), runId: randomUUID(),
      remoteUrl: `https://${remoteKey}.git`, remoteKey, identifier: `${prefix}-${number}`, branch: `mikka/${prefix.toLowerCase()}-${number}`, githubAccountId: String(++githubId),
    }
    fixtures.push(row)
    await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [row.userId, `${row.userId}@example.invalid`])
    await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,$2)', [row.userId, prefix])
    await pool.query('insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values ($1,$2,\'github\',$3,now(),now())', [randomUUID(), row.githubAccountId, row.userId])
    await pool.query('insert into devices (id,"ownerId",name,kind,harnesses) values ($1,$2,\'Publication CI computer\',\'local\',$3)', [row.deviceId, row.userId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('insert into agents (id,"userId","deviceId",harness,name) values ($1,$2,$3,\'codex\',$4)', [row.agentId, row.userId, row.deviceId, `codex ${row.deviceId}`])
    await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") values ($1,$2,$3,$4,$5,null)', [row.repoId, row.deviceId, row.userId, row.remoteKey, row.remoteUrl])
    await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Fix redirect\',$3,\'todo\',\'none\',\'personal\')', [row.issueId, row.userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original task body' }] }] })])
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt) values ($1,$2,$3,$4,$5,$6,\'running\',\'implement\',null,\'Fix redirect\')', [row.runId, row.userId, row.issueId, row.agentId, row.deviceId, row.repoId])
    await pool.query('insert into run_tokens (id,"runId","userId","tokenHash","expiresAt") values ($1,$2,$3,$4,now()+interval \'1 hour\')', [randomUUID(), row.runId, row.userId, `synthetic-${randomUUID()}`])
    if (options.approved) await approval(row, true)
    return row
  }

  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')

    await t.test('concurrent completions and workers create one PR, one history row, and one chat event', async () => {
      const f = await fixture({ approved: true })
      const pinned = await prepareRunPublication(assignment(f), f.remoteUrl)
      assert.equal(pinned.pushBranch, f.branch)
      assert.equal(pinned.policy.permissions.git_push, 'allow')
      const results = await Promise.all(Array.from({ length: 3 }, () => persistRunCompletion(f.userId, f.runId, completion(f))))
      assert.ok(results.every(result => result?.publicationPending))
      assert.deepEqual(await counts(f), { versions: 0, events: 0 })
      assert.equal((await pool.query('select "revokedAt" from run_tokens where "runId"=$1', [f.runId])).rows.every(row => row.revokedAt instanceof Date), true)

      const entered = deferred(), release = deferred()
      let opened = 0
      const open: OpenPullRequest = async input => {
        opened++
        assert.equal(input.githubAccountId, f.githubAccountId)
        assert.equal(input.remoteKey, f.remoteKey)
        assert.equal(input.issueId, f.issueId)
        assert.equal(input.branch, f.branch)
        assert.equal(input.commit, 'a'.repeat(40))
        assert.equal(input.allowCreate, true)
        entered.resolve()
        await release.promise
        await input.onVerified?.({ installationId: 99, repositoryId: 789, githubAccountId: f.githubAccountId, defaultBranch: 'trunk' })
        return prFor(f)
      }
      const first = publishRunResult(f.runId, open)
      try {
        await Promise.race([entered.promise, first.then(() => { throw new Error('Publication ended before calling the injected GitHub client') })])
        assert.deepEqual(await Promise.all([publishRunResult(f.runId, open), publishRunResult(f.runId, open)]), [{ done: false }, { done: false }])
        assert.equal(opened, 1)
      } finally { release.resolve() }
      assert.deepEqual(await first, { done: true })
      assert.deepEqual(await publishRunResult(f.runId, open), { done: true })
      assert.equal(opened, 1)
      assert.deepEqual(await counts(f), { versions: 1, events: 1 })
      const published = await receipt(f)
      assert.equal(published.status, 'published')
      assert.equal(published.attempts, 1)
      assert.deepEqual(published.pullRequest, prFor(f))
      assert.equal(published.leaseToken, null)
      const saved = await task(f)
      assert.equal(saved.status, 'review')
      assert.equal(saved.revision, 2)
      assert.deepEqual(readIssueMetadata(saved.content).pullRequests, [prFor(f)])
      assert.deepEqual((await event(f)).payload.publication.pullRequest, prFor(f))
      assert.equal((await pool.query('select actor_type,actor_id from issue_versions where "issueId"=$1', [f.issueId])).rows[0].actor_type, 'system')
      const binding = (await pool.query('select * from github_repository_installations where "userId"=$1 and "remoteKey"=$2', [f.userId, f.remoteKey])).rows[0]
      assert.equal(binding.githubAccountId, f.githubAccountId)
      assert.equal(String(binding.installationId), '99')

      // Neither an altered retry nor a second worker may overwrite newer human edits.
      const editedContent = withIssueMetadata({ ...saved.content, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Later human edit' }] }] }, { ...readIssueMetadata(saved.content), labels: [{ name: 'Keep this label', color: 'blue' }] })
      await pool.query('update issues set title=\'Later human title\',status=\'doing\',content=$2,revision=revision+1 where id=$1', [f.issueId, JSON.stringify(editedContent)])
      const before = await task(f)
      await persistRunCompletion(f.userId, f.runId, completion(f, 'Changed retry must be ignored'))
      await publishRunResult(f.runId, open)
      assert.deepEqual(await task(f), before)
      assert.equal((await pool.query('select report from agent_runs where id=$1', [f.runId])).rows[0].report.summary, 'Verified redirect fix')
      assert.equal((await event(f)).payload.summary, 'Verified redirect fix')
      assert.deepEqual(await counts(f), { versions: 1, events: 1 })
      assert.equal(opened, 1)
    })

    await t.test('unverified submissions request a draft and report their real verification state', async () => {
      const f = await fixture({ approved: true })
      await prepareRunPublication(assignment(f), f.remoteUrl)
      const submitted = completion(f, 'Work is ready for human review; verification is not configured')
      submitted.report!.verify = { status: 'not_run' }
      assert.equal((await persistRunCompletion(f.userId, f.runId, submitted))?.publicationPending, true)
      const run = (await pool.query('select status,report from agent_runs where id=$1', [f.runId])).rows[0]
      assert.equal(run.status, 'succeeded')
      assert.equal(run.report.verify.status, 'not_run')
      await publishRunResult(f.runId, async input => {
        assert.equal(input.draft, true)
        return { ...prFor(f), state: 'draft' }
      })
      assert.equal((await receipt(f)).pullRequest.state, 'draft')
      assert.equal((await event(f)).payload.verification, 'not_run')
      assert.equal((await event(f)).payload.publication.pullRequest.state, 'draft')
      assert.equal((await task(f)).status, 'review')
      assert.deepEqual(await counts(f), { versions: 1, events: 1 })
    })

    await t.test('terminal replay without a publication receipt cannot undo later task edits', async () => {
      const f = await fixture()
      const initial = await persistRunCompletion(f.userId, f.runId, completion(f))
      assert.equal(initial?.publicationPending, false)
      assert.deepEqual(await counts(f), { versions: 1, events: 1 })
      await pool.query('update issues set title=\'Reopened task\',status=\'todo\',revision=revision+1 where id=$1', [f.issueId])
      const before = await task(f)
      await persistRunCompletion(f.userId, f.runId, completion(f, 'Late conflicting completion'))
      assert.deepEqual(await task(f), before)
      assert.deepEqual(await counts(f), { versions: 1, events: 1 })
      assert.equal((await pool.query('select report from agent_runs where id=$1', [f.runId])).rows[0].report.summary, 'Verified redirect fix')
    })

    await t.test('foreign owners and a different device scope cannot complete or reserve a private task', async () => {
      const owner = await fixture({ approved: true })
      const stranger = await fixture({ approved: true })
      assert.equal(await persistRunCompletion(stranger.userId, owner.runId, completion(owner)), null)
      assert.equal(await persistRunCompletion(owner.userId, owner.runId, completion(owner), stranger.deviceId), null)
      await assert.rejects(prepareRunPublication({ ...assignment(owner), userId: stranger.userId }, owner.remoteUrl), { code: 'issue_unavailable' })
      assert.equal(await receipt(owner), undefined)
      assert.equal((await pool.query('select status from agent_runs where id=$1', [owner.runId])).rows[0].status, 'running')
      assert.deepEqual(await counts(owner), { versions: 0, events: 0 })
      assert.equal((await pool.query('select "revokedAt" from run_tokens where "runId"=$1', [owner.runId])).rows[0].revokedAt, null)
    })

    await t.test('different owners with the same task identifier cannot reserve one repository branch concurrently', async () => {
      const remoteKey = `github.com/mikka-ci/shared-${randomUUID()}`
      const a = await fixture({ approved: true, prefix: 'SAME', number: 7, remoteKey })
      const b = await fixture({ approved: true, prefix: 'SAME', number: 7, remoteKey })
      const results = await Promise.allSettled([prepareRunPublication(assignment(a), a.remoteUrl), prepareRunPublication(assignment(b), b.remoteUrl)])
      const successful = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      assert.equal(successful.length, 1)
      assert.equal(rejected.length, 1)
      assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'pull_request_conflict')
      assert.equal((await pool.query('select count(*) from run_publications where "remoteKey"=$1 and branch=$2', [remoteKey, a.branch])).rows[0].count, '1')
      assert.deepEqual(await counts(a), { versions: 0, events: 0 })
      assert.deepEqual(await counts(b), { versions: 0, events: 0 })
    })

    await t.test('missing human approval and revoked approval cannot open a PR', async () => {
      let opened = 0
      const neverOpen: OpenPullRequest = async () => { opened++; throw new Error('GitHub must not be called without owner approval') }
      const unapproved = await fixture()
      // A naked boolean has no authenticated human approval receipt.
      await approval(unapproved, true, false)
      assert.equal((await prepareRunPublication(assignment(unapproved), unapproved.remoteUrl)).policy.permissions.git_push, 'ask')
      assert.equal((await persistRunCompletion(unapproved.userId, unapproved.runId, completion(unapproved)))?.publicationPending, false)
      await publishRunResult(unapproved.runId, neverOpen)
      assert.equal((await receipt(unapproved)).errorCode, 'push_not_approved')
      assert.equal((await event(unapproved)).payload.publication.errorCode, 'push_not_approved')

      const revoked = await fixture({ approved: true })
      assert.equal((await prepareRunPublication(assignment(revoked), revoked.remoteUrl)).policy.permissions.git_push, 'allow')
      assert.equal((await persistRunCompletion(revoked.userId, revoked.runId, completion(revoked)))?.publicationPending, true)
      await approval(revoked, false)
      assert.deepEqual(await publishRunResult(revoked.runId, neverOpen), { done: true })
      assert.equal((await receipt(revoked)).status, 'blocked')
      assert.equal((await receipt(revoked)).errorCode, 'push_not_approved')
      assert.equal((await event(revoked)).payload.publication.errorCode, 'push_not_approved')

      // A pre-claim retry refreshes its still-assigned approval snapshot too.
      const refreshed = await fixture({ approved: true })
      await prepareRunPublication(assignment(refreshed), refreshed.remoteUrl)
      await approval(refreshed, false)
      assert.equal((await prepareRunPublication(assignment(refreshed), refreshed.remoteUrl)).policy.permissions.git_push, 'ask')
      assert.equal((await receipt(refreshed)).pushApproved, false)
      assert.equal(opened, 0)
    })

    await t.test('a created PR remains in receipt and chat if task metadata fills during the GitHub call', async () => {
      const f = await fixture({ approved: true })
      await prepareRunPublication(assignment(f), f.remoteUrl)
      await persistRunCompletion(f.userId, f.runId, completion(f))
      const existing = Array.from({ length: 10 }, (_, index) => prFor(f, index + 1))
      const created = prFor(f, 88)
      const open: OpenPullRequest = async input => {
        assert.equal(input.allowCreate, true)
        await pool.query('update issues set content=jsonb_set(content,\'{attrs,mikka,pullRequests}\',$2::jsonb),revision=revision+1 where id=$1', [f.issueId, JSON.stringify(existing)])
        return created
      }
      assert.deepEqual(await publishRunResult(f.runId, open), { done: true })
      const published = await receipt(f)
      assert.equal(published.status, 'published')
      assert.equal(published.errorCode, 'pull_request_limit')
      assert.deepEqual(published.pullRequest, created)
      assert.deepEqual(readIssueMetadata((await task(f)).content).pullRequests, existing)
      const result = (await event(f)).payload.publication
      assert.deepEqual(result.pullRequest, created)
      assert.equal(result.errorCode, 'pull_request_limit')
      assert.deepEqual(await counts(f), { versions: 1, events: 1 })
      assert.deepEqual(await publishRunResult(f.runId, async () => { throw new Error('An attached external result must not be recreated') }), { done: true })
    })

    await t.test('a transient GitHub failure retries the frozen completion and converges on one result', async () => {
      const f = await fixture({ approved: true })
      await prepareRunPublication(assignment(f), f.remoteUrl)
      await persistRunCompletion(f.userId, f.runId, completion(f))
      let attempts = 0
      const open: OpenPullRequest = async input => {
        assert.equal(input.summary, 'Verified redirect fix')
        if (++attempts === 1) throw new PublicationError('github_unavailable', true)
        return prFor(f)
      }
      assert.deepEqual(await publishRunResult(f.runId, open), { done: false })
      const pending = await receipt(f)
      assert.equal(pending.status, 'pending')
      assert.equal(pending.attempts, 1)
      assert.equal(pending.leaseToken, null)
      assert.deepEqual(await counts(f), { versions: 0, events: 0 })
      await persistRunCompletion(f.userId, f.runId, completion(f, 'Different retry summary'))
      assert.deepEqual(await publishRunResult(f.runId, open), { done: true })
      assert.equal((await receipt(f)).attempts, 2)
      assert.deepEqual((await receipt(f)).pullRequest, prFor(f))
      assert.deepEqual(await counts(f), { versions: 1, events: 1 })
      assert.deepEqual(await publishRunResult(f.runId, open), { done: true })
      assert.equal(attempts, 2)
    })
  } finally {
    const users = fixtures.map(fixture => fixture.userId)
    if (users.length) {
      // All identifiers belong to this test's disposable fixtures.
      for (const table of ['coordinator_events', 'run_publications', 'run_tokens', 'agent_runs', 'issue_versions', 'issues', 'repository_settings', 'github_repository_installations', 'device_repos', 'agents']) await pool.query(`delete from ${table} where "userId"=any($1::text[])`, [users])
      await pool.query('delete from devices where "ownerId"=any($1::text[])', [users])
      await pool.query('delete from "user" where id=any($1::text[])', [users])
    }
    await pool.end()
    const workspacePool = (globalThis as { workspacePool?: { end(): Promise<void> } }).workspacePool
    if (workspacePool) await workspacePool.end()
  }
})
