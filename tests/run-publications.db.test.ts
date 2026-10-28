import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { RunCompleteRequest } from '@mikka/protocol/run'
import type { PublishedPullRequest } from '../lib/run-publication-result'
import type { openRunPullRequest } from '../lib/github/run-pull-request'
import type { RepositoryAdmission } from '../lib/repository-admission'
import { remoteKey as repositoryKey } from '@mikka/protocol/repository'

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
  remoteUrl: string; remoteKey: string; identifier: string; branch: string; githubAccountId: string; repositoryAdmission: RepositoryAdmission | null
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

  const assignment = (fixture: Fixture) => ({ id: fixture.runId, userId: fixture.userId, issueId: fixture.issueId, deviceId: fixture.deviceId, agentId: fixture.agentId, baseBranch: null, repositoryAdmission: fixture.repositoryAdmission })
  const prFor = (fixture: Fixture, number = 77): PublishedPullRequest => ({ url: `https://${fixture.remoteKey.slice(3)}/pull/${number}`, state: 'open' })
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
  const fixture = async (options: { approved?: boolean; prefix?: string; number?: number; remoteKey?: string; remoteUrl?: string } = {}) => {
    const seed = randomUUID()
    const prefix = options.prefix ?? 'TEST'
    const number = options.number ?? 1
    const remoteKey = options.remoteUrl ? repositoryKey(options.remoteUrl) : options.remoteKey ?? `v2/github.com/mikka-ci/repo-${seed}`
    const row: Fixture = {
      userId: `publication-${seed}`, deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), issueId: randomUUID(), runId: randomUUID(),
      remoteUrl: options.remoteUrl ?? `https://${remoteKey.slice(3)}.git`, remoteKey, identifier: `${prefix}-${number}`, branch: `mikka/${prefix.toLowerCase()}-${number}`, githubAccountId: String(++githubId), repositoryAdmission: null,
    }
    fixtures.push(row)
    await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [row.userId, `${row.userId}@example.invalid`])
    await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,$2)', [row.userId, prefix])
    await pool.query('insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values ($1,$2,\'github\',$3,now(),now())', [randomUUID(), row.githubAccountId, row.userId])
    await pool.query('insert into devices (id,"ownerId",name,kind,harnesses) values ($1,$2,\'Publication CI computer\',\'local\',$3)', [row.deviceId, row.userId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('insert into agents (id,"userId","deviceId",harness,name) values ($1,$2,$3,\'codex\',$4)', [row.agentId, row.userId, row.deviceId, `codex ${row.deviceId}`])
    await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") values ($1,$2,$3,$4,$5,null)', [row.repoId, row.deviceId, row.userId, row.remoteKey, row.remoteUrl])
    await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Fix redirect\',$3,\'todo\',\'normal\',\'personal\')', [row.issueId, row.userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original task body' }] }] })])
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt) values ($1,$2,$3,$4,$5,$6,\'running\',\'implement\',null,\'Fix redirect\')', [row.runId, row.userId, row.issueId, row.agentId, row.deviceId, row.repoId])
    await pool.query('insert into run_tokens (id,"runId","userId","tokenHash","expiresAt") values ($1,$2,$3,$4,now()+interval \'1 hour\')', [randomUUID(), row.runId, row.userId, `synthetic-${randomUUID()}`])
    if (options.approved) {
      await approval(row, true)
      const { admitRepositoryTask } = await import('../lib/repository-admission')
      const stored = (await pool.query('select push from repository_settings where "userId"=$1 and "remoteKey"=$2', [row.userId, row.remoteKey])).rows[0].push
      row.repositoryAdmission = admitRepositoryTask({ ...row, targetBranch: row.branch, push: stored, now: new Date() })
      assert.ok(row.repositoryAdmission)
      await pool.query('update agent_runs set "repositoryAdmission"=$2 where id=$1', [row.runId, JSON.stringify(row.repositoryAdmission)])
    }
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

    await t.test('unverified work without an approved matching push cannot succeed or advance the task', async () => {
      for (const mode of ['unapproved', 'not-pushed', 'wrong-branch'] as const) {
        const f = await fixture({ approved: mode !== 'unapproved' })
        if (mode === 'unapproved') {
          await assert.rejects(prepareRunPublication(assignment(f), f.remoteUrl), { code: 'push_not_approved' })
          assert.equal(await receipt(f), undefined)
          continue
        }
        await prepareRunPublication(assignment(f), f.remoteUrl)
        const submitted = completion(f, 'Unverified submission')
        submitted.report!.verify = { status: 'not_run' }
        if (mode === 'not-pushed') submitted.report!.publish!.pushed = false
        if (mode === 'wrong-branch') submitted.report!.publish!.branch = 'main'
        assert.equal((await persistRunCompletion(f.userId, f.runId, submitted))?.publicationPending, false)
        const run = (await pool.query('select status,report from agent_runs where id=$1', [f.runId])).rows[0]
        assert.equal(run.status, 'stopped')
        assert.equal(run.report.verify.status, 'not_run')
        assert.equal((await task(f)).status, 'todo')
        assert.equal((await receipt(f)).status, 'blocked')
        assert.equal((await receipt(f)).pullRequest, null)
        await publishRunResult(f.runId, async () => { throw new Error('Unapproved or unpushed unverified work must never reach GitHub') })
        assert.deepEqual(await counts(f), { versions: 0, events: 1 })
      }
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
      await assert.rejects(prepareRunPublication({ ...assignment(owner), userId: stranger.userId }, owner.remoteUrl), { code: 'push_not_approved' })
      assert.equal(await receipt(owner), undefined)
      assert.equal((await pool.query('select status from agent_runs where id=$1', [owner.runId])).rows[0].status, 'running')
      assert.deepEqual(await counts(owner), { versions: 0, events: 0 })
      assert.equal((await pool.query('select "revokedAt" from run_tokens where "runId"=$1', [owner.runId])).rows[0].revokedAt, null)
    })

    await t.test('different owners with the same task identifier cannot reserve one repository branch concurrently', async () => {
      const remoteKey = `v2/github.com/mikka-ci/shared-${randomUUID()}`
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

    await t.test('legacy and foreign repository receipts fail closed', async () => {
      const f = await fixture({ approved: true })
      await assert.rejects(prepareRunPublication({ ...assignment(f), userId: 'foreign' }, f.remoteUrl), { code: 'push_not_approved' })
      await assert.rejects(prepareRunPublication(assignment(f), 'https://github.com/other/repo.git'), { code: 'push_not_approved' })
      await assert.rejects(prepareRunPublication({ ...assignment(f), repositoryAdmission: null }, f.remoteUrl), { code: 'push_not_approved' })
    })

    await t.test('revocation after acceptance does not cancel the frozen publication', async () => {
      const f = await fixture({ approved: true })
      assert.equal((await prepareRunPublication(assignment(f), f.remoteUrl)).policy.permissions.git_push, 'allow')
      await persistRunCompletion(f.userId, f.runId, completion(f))
      await approval(f, false)
      let writes = 0
      assert.deepEqual(await publishRunResult(f.runId, async () => { writes++; return prFor(f) }), { done: true })
      assert.equal(writes, 1)
      assert.equal((await receipt(f)).status, 'published')
    })

    await t.test('queue admission commits the target and rejects a new task after revocation', async () => {
      const { queueRun } = await import('../lib/agent-runs')
      const { writeRepositoryPushApproval } = await import('../lib/repository-approval-write')
      const f = await fixture({ approved: true })
      const accepted = await queueRun(f.userId, { issueId: f.issueId, agentId: f.agentId, repo: f.remoteUrl, note: 'before revocation' })
      const stored = (await pool.query('select "repositoryAdmission" from agent_runs where id=$1', [accepted.runId])).rows[0].repositoryAdmission
      assert.equal(stored.userId, f.userId)
      assert.equal(stored.issueId, f.issueId)
      assert.equal(stored.deviceId, f.deviceId)
      assert.equal(stored.agentId, f.agentId)
      assert.equal(stored.remoteKey, f.remoteKey)
      assert.equal(stored.targetBranch, f.branch)
      assert.equal((await pool.query('select branch from run_publications where "runId"=$1', [accepted.runId])).rows[0].branch, f.branch)
      const eventId = randomUUID(), otherDevice = randomUUID(), otherAgent = randomUUID()
      await pool.query('insert into coordinator_events (id,"userId",kind,"dedupeKey",payload,"deliveredAt") values ($1,$2,\'user_message\',$3,$4,now())', [eventId, f.userId, `task-request-${eventId}`, JSON.stringify({ text: 'selected device', taskDestination: { kind: 'device', deviceId: f.deviceId } })])
      await pool.query('insert into task_request_bindings ("eventId","userId","deviceId","issueId","toolCallId","inputHash") values ($1,$2,$3,$4,$5,$6)', [eventId, f.userId, f.deviceId, f.issueId, 'fixture', 'fixture'])
      await pool.query('insert into devices (id,"ownerId",name,kind,harnesses) values ($1,$2,\'Other device\',\'local\',$3)', [otherDevice, f.userId, JSON.stringify([{ harness: 'codex', installed: true }])])
      await pool.query('insert into agents (id,"userId","deviceId",harness,name) values ($1,$2,$3,\'codex\',$4)', [otherAgent, f.userId, otherDevice, `codex ${otherDevice}`])
      await assert.rejects(queueRun(f.userId, { issueId: f.issueId, agentId: otherAgent, repo: f.remoteUrl }))
      await writeRepositoryPushApproval(f.userId, f.remoteKey, false)
      await assert.rejects(queueRun(f.userId, { issueId: f.issueId, agentId: f.agentId, repo: f.remoteUrl, note: 'after revocation' }))
      assert.equal((await pool.query('select "repositoryAdmission" from agent_runs where id=$1', [accepted.runId])).rows[0].repositoryAdmission.targetBranch, f.branch)
    })

    await t.test('new messages serialize with revocation and STOP remains independent', async () => {
      const { sendOwnedRunMessage, stopOwnedRun } = await import('../lib/run-control')
      const { writeRepositoryPushApproval } = await import('../lib/repository-approval-write')
      const { db } = await import('../lib/db')
      const f = await fixture({ approved: true })
      await sendOwnedRunMessage(db, f.userId, { runId: f.runId, text: 'accepted before revocation' })
      const saved = (await pool.query('select "repositoryAdmission" from run_messages where "runId"=$1', [f.runId])).rows
      assert.equal(saved.length, 1)
      assert.equal(saved[0].repositoryAdmission.targetBranch, f.branch)
      await writeRepositoryPushApproval(f.userId, f.remoteKey, false)
      await assert.rejects(sendOwnedRunMessage(db, f.userId, { runId: f.runId, text: 'after revocation' }))
      assert.equal(Number((await pool.query('select count(*) from run_messages where "runId"=$1', [f.runId])).rows[0].count), 1)
      await stopOwnedRun(db, f.userId, f.runId)
      assert.ok((await pool.query('select "stopRequestedAt" from agent_runs where id=$1', [f.runId])).rows[0].stopRequestedAt)
      await assert.rejects(sendOwnedRunMessage(db, f.userId, { runId: f.runId, text: 'after stop' }))
    })

    await t.test('revocation holds the same lock as message acceptance', async () => {
      const { sendOwnedRunMessage } = await import('../lib/run-control')
      const { db } = await import('../lib/db')
      const f = await fixture({ approved: true })
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['repository-approval', f.userId, f.remoteKey])])
        await client.query('update repository_settings set push=$3 where "userId"=$1 and "remoteKey"=$2', [f.userId, f.remoteKey, JSON.stringify({ approved: false, remote: 'origin', approvedByUserId: f.userId, approvedAt: new Date().toISOString() })])
        const message = sendOwnedRunMessage(db, f.userId, { runId: f.runId, text: 'contended' })
        await new Promise(resolve => setImmediate(resolve))
        await client.query('commit')
        await assert.rejects(message)
        assert.equal(Number((await pool.query('select count(*) from run_messages where "runId"=$1', [f.runId])).rows[0].count), 0)
      } finally { await client.query('rollback').catch(() => {}); client.release() }
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
    await t.test('repository push proposals require an owner decision and bind the v2 endpoint', async () => {
      if (process.env.VERCEL || process.env.MIKKA_NATIVE_COORDINATOR || process.env.AI_GATEWAY_API_KEY) throw new Error('Approval regression requires the isolated no-provider CI environment')
      const { proposeRepositoryPush } = await import('../lib/pending-action-store')
      const { decidePendingAction } = await import('../lib/pending-actions')
      const { writeRepositoryPushApproval } = await import('../lib/repository-approval-write')
      const owner = await fixture(), other = await fixture()
      const repo = 'https://git.example.com:8443/Team/Repo.git'
      const request = await proposeRepositoryPush(owner.userId, { repo })
      assert.ok('actionId' in request && request.actionId)
      const id = request.actionId
      const count = async () => Number((await pool.query('select count(*) from repository_settings where "userId"=$1 and "remoteKey"=$2', [owner.userId, repositoryKey(repo)])).rows[0].count)
      assert.equal(await count(), 0, 'the model proposal alone cannot grant a push')
      await assert.rejects(decidePendingAction(other.userId, id, true))
      assert.equal(await count(), 0)
      assert.equal((await decidePendingAction(owner.userId, id, true)).status, 'done')
      const { rows } = await pool.query('select push from repository_settings where "userId"=$1 and "remoteKey"=$2', [owner.userId, repositoryKey(repo)])
      assert.equal(rows[0].push.approvedByUserId, owner.userId)
      assert.equal(rows[0].push.approved, true)
      assert.equal((await pool.query('select count(*)::int as n from repository_settings where "userId"=$1 and "remoteKey"=$2', [owner.userId, repositoryKey('https://git.example.com:9443/Team/Repo.git')])).rows[0].n, 0)
      await assert.rejects(decidePendingAction(owner.userId, id, true), 'a consumed approval cannot be replayed')
      const pending = await proposeRepositoryPush(owner.userId, { repo })
      assert.ok('actionId' in pending && pending.actionId)
      const raced = await Promise.allSettled([
        decidePendingAction(owner.userId, pending.actionId, true),
        writeRepositoryPushApproval(owner.userId, repositoryKey(repo), false),
      ])
      assert.equal(raced[1].status, 'fulfilled')
      assert.equal((await pool.query('select push from repository_settings where "userId"=$1 and "remoteKey"=$2', [owner.userId, repositoryKey(repo)])).rows[0].push.approved, false)
      await assert.rejects(decidePendingAction(owner.userId, pending.actionId, true), 'revocation invalidates old pending confirmations')
      const declined = await proposeRepositoryPush(owner.userId, { repo: 'other/repo' })
      assert.ok('actionId' in declined && declined.actionId)
      assert.equal((await decidePendingAction(owner.userId, declined.actionId, false)).status, 'declined')
      assert.equal((await pool.query('select count(*)::int as n from repository_settings where "userId"=$1 and "remoteKey"=$2', [owner.userId, repositoryKey('other/repo')])).rows[0].n, 0)
      const tampered = await proposeRepositoryPush(owner.userId, { repo: 'team/repo' })
      assert.ok('actionId' in tampered && tampered.actionId)
      await pool.query('update pending_actions set input = jsonb_set(input, \'{remoteKey}\', to_jsonb($2::text)) where id=$1', [tampered.actionId, 'github.com/team/repo'])
      await assert.rejects(decidePendingAction(owner.userId, tampered.actionId, true))
      assert.equal((await pool.query('select status from pending_actions where id=$1', [tampered.actionId])).rows[0].status, 'pending')
      const expired = await proposeRepositoryPush(owner.userId, { repo: 'expired/repository' })
      assert.ok('actionId' in expired && expired.actionId)
      await pool.query('update pending_actions set "createdAt"=now()-interval \'8 days\' where id=$1', [expired.actionId])
      await assert.rejects(decidePendingAction(owner.userId, expired.actionId, true), 'expired confirmations cannot authorize a push')
      assert.equal((await pool.query('select count(*)::int as n from repository_settings where "userId"=$1 and "remoteKey"=$2', [owner.userId, repositoryKey('expired/repository')])).rows[0].n, 0)
    })
  } finally {
    const users = fixtures.map(fixture => fixture.userId)
    if (users.length) {
      // All identifiers belong to this test's disposable fixtures.
      for (const table of ['pending_actions', 'coordinator_events', 'run_publications', 'run_tokens', 'agent_runs', 'issue_versions', 'issues', 'repository_settings', 'github_repository_installations', 'device_repos', 'agents']) await pool.query(`delete from ${table} where "userId"=any($1::text[])`, [users])
      await pool.query('delete from devices where "ownerId"=any($1::text[])', [users])
      await pool.query('delete from "user" where id=any($1::text[])', [users])
    }
    await pool.end()
    const workspacePool = (globalThis as { workspacePool?: { end(): Promise<void> } }).workspacePool
    if (workspacePool) await workspacePool.end()
  }
})
