import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { RunCompleteRequest } from '@mikka/protocol/run'
import type { PublishedPullRequest } from '../lib/run-publication-result'
import type { openRunPullRequest } from '../lib/github/run-pull-request'
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
      remoteUrl: options.remoteUrl ?? `https://${remoteKey.slice(3)}.git`, remoteKey, identifier: `${prefix}-${number}`, branch: `mikka/${prefix.toLowerCase()}-${number}`, githubAccountId: String(++githubId),
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
    if (options.approved) await approval(row, true)
    return row
  }

  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')

    await t.test('a run that ends during human control accepts its terminal report and clears pause metadata', async () => {
      const f = await fixture()
      await pool.query(`UPDATE agent_runs SET status='paused',"pauseReason"='human_control',"resumeStatus"='running' WHERE id=$1`, [f.runId])
      const result = await persistRunCompletion(f.userId,f.runId,{stopReason:'timeout'})
      assert.ok(result)
      const ended = (await pool.query('SELECT status,"pauseReason","resumeStatus" FROM agent_runs WHERE id=$1',[f.runId])).rows[0]
      assert.deepEqual(ended,{status:'failed',pauseReason:null,resumeStatus:null})
    })

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
      await assert.rejects(prepareRunPublication({ ...assignment(owner), userId: stranger.userId }, owner.remoteUrl), { code: 'issue_unavailable' })
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

    await t.test('different endpoints and legacy keys cannot lend an owner approval to another repository', async () => {
      const f = await fixture({ remoteUrl: 'https://git.example.com:9443/team/repo.git' })
      const aKey = repositoryKey('https://git.example.com:8443/Team/Repo.git')
      await approval({ ...f, remoteKey: aKey }, true)
      await approval({ ...f, remoteKey: 'git.example.com/team/repo' }, true)
      assert.equal((await prepareRunPublication(assignment(f), f.remoteUrl)).policy.permissions.git_push, 'ask')
      assert.equal((await receipt(f)).remoteKey, f.remoteKey)
      const github = await fixture()
      await approval({ ...github, remoteKey: github.remoteKey.slice(3) }, true)
      assert.equal((await prepareRunPublication(assignment(github), github.remoteUrl)).policy.permissions.git_push, 'ask', 'old GitHub keys also require explicit reapproval')
      await approval(github, true)
      assert.equal((await prepareRunPublication(assignment(github), github.remoteUrl)).policy.permissions.git_push, 'allow')
      await pool.query('UPDATE run_publications SET "remoteKey"=$2 WHERE "runId"=$1', [github.runId, github.remoteKey.slice(3)])
      await assert.rejects(prepareRunPublication(assignment(github), github.remoteUrl), { code: 'publication_mismatch' })
      await persistRunCompletion(github.userId, github.runId, completion(github))
      let opened = 0
      assert.deepEqual(await publishRunResult(github.runId, async () => { opened++; throw new Error('Legacy publication must not contact GitHub') }), { done: true })
      assert.equal(opened, 0)
      assert.equal((await receipt(github)).errorCode, 'publication_mismatch')
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

    await t.test('an unknown legacy scope pin cannot be inferred from the current task', async () => {
      const f = await fixture({ approved: true })
      await prepareRunPublication(assignment(f), f.remoteUrl)
      await persistRunCompletion(f.userId, f.runId, completion(f))
      await pool.query('update run_publications set "scopeVersion"=null,"issueTitle"=null where "runId"=$1', [f.runId])
      const before = await task(f)
      assert.deepEqual(await publishRunResult(f.runId, async () => { throw new Error('Unknown generation must not contact GitHub') }), { done: true })
      assert.equal((await receipt(f)).errorCode, 'issue_unavailable')
      assert.deepEqual(await task(f), before)
    })

    await t.test('skill evidence and pending publication commit atomically and terminal replay cannot mint evidence', async () => {
      const { skillAssignments } = await import('../lib/self-improvement/server')
      async function mountedFixture() {
        const f = await fixture({ approved: true })
        await prepareRunPublication(assignment(f), f.remoteUrl)
        await pool.query('update agent_runs set status=\'queued\' where id=$1', [f.runId])
        await skillAssignments.selectBaseline(f.userId, f.runId)
        const lease = new Date(Date.now() + 60_000).toISOString(), sessionId = randomUUID()
        await pool.query('update agent_runs set status=\'preparing\',"startedAt"=clock_timestamp(),"leaseExpiresAt"=$2,"sessionId"=$3 where id=$1', [f.runId, lease, sessionId])
        const { skillReceipt } = await skillAssignments.recordClaim(f.userId, f.deviceId, f.runId, lease, true)
        assert.ok(skillReceipt)
        const input = completion(f)
        assert.ok(input.report)
        input.report.skillMount = { receiptId: skillReceipt.id, versionId: skillReceipt.artifact.versionId, sha256: skillReceipt.artifact.sha256, sessionId, mountedAt: new Date().toISOString() }
        return { f, input }
      }
      const rejected = await mountedFixture()
      const constraint = `publication_atomic_${rejected.f.runId.replaceAll('-', '')}`
      await pool.query(`alter table run_publications add constraint ${constraint} check ("runId" <> '${rejected.f.runId}'::uuid or status <> 'pending') not valid`)
      await assert.rejects(persistRunCompletion(rejected.f.userId, rejected.f.runId, rejected.input))
      assert.equal((await pool.query('select count(*)::int n from improvement_skill_mounts where "runId"=$1', [rejected.f.runId])).rows[0].n, 0, 'later receipt failure rolls back the skill ledger')
      assert.deepEqual((await pool.query('select status,report,"finishedAt" from agent_runs where id=$1', [rejected.f.runId])).rows[0], { status: 'preparing', report: null, finishedAt: null })
      assert.equal((await receipt(rejected.f)).status, 'assigned')
      assert.equal((await pool.query('select "revokedAt" from run_tokens where "runId"=$1', [rejected.f.runId])).rows.every(row => row.revokedAt === null), true)
      assert.deepEqual(await counts(rejected.f), { versions: 0, events: 0 })

      const accepted = await mountedFixture()
      assert.equal((await persistRunCompletion(accepted.f.userId, accepted.f.runId, accepted.input))?.publicationPending, true)
      const before = (await pool.query('select * from improvement_skill_mounts where "runId"=$1', [accepted.f.runId])).rows
      assert.equal(before.length, 1)
      const stored = (await pool.query('select status,report,"finishedAt","startedAt" from agent_runs where id=$1', [accepted.f.runId])).rows[0]
      assert.equal(stored.status, 'succeeded')
      assert.ok(stored.finishedAt >= stored.startedAt)
      assert.deepEqual(stored.report, accepted.input.report)
      const replay = { ...accepted.input, report: { ...accepted.input.report!, summary: 'Altered replay', skillMount: { ...accepted.input.report!.skillMount!, receiptId: randomUUID() } } }
      assert.equal((await persistRunCompletion(accepted.f.userId, accepted.f.runId, replay))?.publicationPending, true)
      assert.deepEqual((await pool.query('select * from improvement_skill_mounts where "runId"=$1', [accepted.f.runId])).rows, before)
      assert.deepEqual((await pool.query('select report from agent_runs where id=$1', [accepted.f.runId])).rows[0].report, stored.report)
      assert.deepEqual(await publishRunResult(accepted.f.runId, async () => prFor(accepted.f)), { done: true })
      assert.deepEqual(await counts(accepted.f), { versions: 1, events: 1 })
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
      assert.deepEqual(await proposeRepositoryPush(owner.userId, { repo }), { status: 'approved' })
      const raceRepo = 'https://git.example.com:8443/Team/Other.git'
      const pending = await proposeRepositoryPush(owner.userId, { repo: raceRepo })
      assert.ok('actionId' in pending && pending.actionId)
      assert.deepEqual(await proposeRepositoryPush(owner.userId, { repo: raceRepo }), pending)
      const raced = await Promise.allSettled([
        decidePendingAction(owner.userId, pending.actionId, true),
        writeRepositoryPushApproval(owner.userId, repositoryKey(raceRepo), false),
      ])
      assert.equal(raced[1].status, 'fulfilled')
      assert.equal((await pool.query('select push from repository_settings where "userId"=$1 and "remoteKey"=$2', [owner.userId, repositoryKey(raceRepo)])).rows[0].push.approved, false)
      assert.deepEqual(await proposeRepositoryPush(owner.userId, { repo: raceRepo }), { status: 'denied' })
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
    await t.test('real approval chain freezes admission, serializes revocation and rejects new prompts without blocking stop', async () => {
      const { queueRun } = await import('../lib/agent-runs')
      const { sendOwnedRunMessage, stopOwnedRun } = await import('../lib/run-control')
      const { db } = await import('../lib/db')
      const { proposeRepositoryPush } = await import('../lib/pending-action-store')
      const { decidePendingAction } = await import('../lib/pending-actions')
      const { writeRepositoryPushApproval } = await import('../lib/repository-approval-write')
      const { coordinatorEnabled } = await import('../lib/coordinator/wake')
      assert.equal(coordinatorEnabled(), false, 'this DB suite cannot invoke a real model')
      const f = await fixture({ prefix: 'ADMI' })
      // This fixture supplies historical publication/legacy-alias evidence.
      // The admission under test creates the next run, subject to the real
      // one-live-run gate; keep the original row without leaving it active.
      await pool.query('update agent_runs set status=\'succeeded\',"finishedAt"=clock_timestamp(),"leaseExpiresAt"=NULL where id=$1', [f.runId])
      await pool.query('update devices set "protocolVersion"=3 where id=$1', [f.deviceId])
      const input = { issueId: f.issueId, agentId: f.agentId, repo: f.remoteUrl }
      const eventId = randomUUID()
      // The person's Coordinator is an ordinary bot row in their workspace; the request is in its chat.
      const {seedWorkspace}=await import('./support/workspace-admin-db')
      const workspace=await seedWorkspace(pool,f.userId,[{userId:f.userId,role:'admin'}])
      const coordinator = await (await import('../lib/coordinator/coordinator-bot')).chatBotId(f.userId, null, workspace.id)
      await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId",payload,"deliveredAt") values ($1,$2,$6,\'user_message\',$5,$3,$4,now())', [eventId, f.userId, f.issueId, JSON.stringify({ text: 'Synthetic owner task; no provider invocation', taskDestination: { kind: 'device', deviceId: f.deviceId } }), 'admission:' + eventId, coordinator])
      const before = Number((await pool.query('select count(*) as n from agent_runs where "userId"=$1', [f.userId])).rows[0].n)
      await assert.rejects(queueRun(f.userId, input, coordinator, undefined, eventId), /runInvalid/, 'ask cannot execute before its human decision')
      const proposal = await proposeRepositoryPush(f.userId, { repo: f.remoteUrl }, { eventId, botId: coordinator })
      assert.ok('actionId' in proposal && proposal.actionId)
      assert.deepEqual(await proposeRepositoryPush(f.userId, { repo: f.remoteUrl }, { eventId, botId: coordinator }), proposal)
      assert.equal((await decidePendingAction(f.userId, proposal.actionId, true)).status, 'done')
      const { takeInbox } = await import('../lib/coordinator/store')
      assert.equal((await takeInbox(f.userId,'retained-admission-suite',coordinator)).added,0,'a decision event remains pending without model classification')
      // This PG suite disables Coordinator/model network execution. Supply a
      // declared provider substitute through the real triage client and CAS;
      // do not turn an action_decided event into an automatic runtime tier.
      const {hostedUsage}=await import('../lib/abuse/runtime')
      await hostedUsage.verify(workspace.id,'cus_synthetic_admission',`card_admission_${randomUUID()}`)
      const { triageInbox } = await import('../lib/coordinator/wake')
      const { DECISION_MODEL, DECISIONS_URL } = await import('../lib/coordinator/decision')
      const originalFetch=globalThis.fetch,originalDecisionKey=process.env.AI_GATEWAY_API_KEY
      let decisions=0
      process.env.AI_GATEWAY_API_KEY='synthetic-publication-triage'
      globalThis.fetch=(async(url,init)=>{
        assert.equal(String(url),DECISIONS_URL,'only the declared synthetic decision provider may be called')
        const request=JSON.parse(String(init?.body))
        assert.equal(request.model,DECISION_MODEL)
        assert.equal(request.questions[0].name,'tier')
        decisions++
        return Response.json({model:DECISION_MODEL,provider_metadata:{gateway:{generationId:`synthetic-admission-${decisions}`,cost:'0.001'}},answers:[{type:'choice',name:'tier',choice:'result'}]})
      }) as typeof fetch
      try {await triageInbox(f.userId,coordinator);assert.equal(decisions,1)}
      finally {globalThis.fetch=originalFetch;if(originalDecisionKey===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=originalDecisionKey}
      const resumed = await takeInbox(f.userId, 'retained-admission-suite', coordinator)
      assert.equal(resumed.taskEventId, eventId, 'approval resumes the original host request, without asking the model for its event ID')
      assert.equal(resumed.approvedRepositoryKey, f.remoteKey)
      await assert.rejects(queueRun(f.userId, { ...input, repo: 'different/repository' }, coordinator, undefined, resumed.taskEventId, null, resumed.approvedRepositoryKey), /runInvalid/)
      const admitted = await Promise.all([queueRun(f.userId, input, coordinator, undefined, resumed.taskEventId, null, resumed.approvedRepositoryKey), queueRun(f.userId, input, coordinator, undefined, resumed.taskEventId, null, resumed.approvedRepositoryKey)])
      assert.equal(admitted[0].runId, admitted[1].runId, 'host replay cannot enqueue a second execution')
      const runId = admitted[0].runId
      const accepted = (await pool.query('select * from agent_runs where id=$1', [runId])).rows[0]
      assert.equal(accepted.agentDefinition.repositoryAdmission.requestEventId, eventId)
      assert.equal(accepted.agentDefinition.repositoryAdmission.deviceId, f.deviceId)
      assert.equal(accepted.agentDefinition.repositoryAdmission.targetBranch, f.branch)
      assert.equal(Number((await pool.query('select count(*) as n from agent_runs where "userId"=$1', [f.userId])).rows[0].n), before + 1)
      await sendOwnedRunMessage(db, f.userId, { runId, text: 'Accepted before revocation' })
      await assert.rejects(queueRun(f.userId, input), /runInvalid/, 'attributed tasks cannot omit their host event')
      await assert.rejects(queueRun(f.userId, input, null, undefined, randomUUID()), /runInvalid/)
      await writeRepositoryPushApproval(f.userId, f.remoteKey, false)
      assert.deepEqual(await proposeRepositoryPush(f.userId, { repo: f.remoteUrl }), { status: 'denied' })
      await assert.rejects(sendOwnedRunMessage(db, f.userId, { runId, text: 'New authority after revocation' }), /runInvalid/)
      // A completed historical row is rejected before repository checks. Use
      // a separate live legacy execution so this negative case exercises the
      // real remote-key approval lookup without resurrecting f.runId or adding
      // a second live execution to the admitted task.
      const legacyRepo = randomUUID(), legacyIssue = randomUUID(), legacyRun = randomUUID()
      await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl") values ($1,$2,$3,$4,$5)', [legacyRepo, f.deviceId, f.userId, '/legacy-user-checkout', f.remoteUrl])
      await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Live legacy execution\',$3,\'todo\',\'normal\',\'personal\')', [legacyIssue, f.userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 3 } }, content: [] })])
      await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,prompt) values ($1,$2,$3,$4,$5,$6,\'running\',\'implement\',\'Synthetic legacy execution\')', [legacyRun, f.userId, legacyIssue, f.agentId, f.deviceId, legacyRepo])
      assert.deepEqual((await pool.query('select status,"agentDefinition" from agent_runs where id=$1', [legacyRun])).rows[0], { status: 'running', agentDefinition: null })
      await assert.rejects(sendOwnedRunMessage(db, f.userId, { runId: legacyRun, text: 'Legacy aliases cannot bypass revocation' }), /runInvalid/)
      assert.equal(Number((await pool.query('select count(*) as n from run_messages where "runId"=$1', [legacyRun])).rows[0].n), 0)
      await assert.rejects(sendOwnedRunMessage(db, f.userId, { runId: f.runId, text: 'Finished runs cannot be reopened' }), /runNotFound/)
      assert.equal(Number((await pool.query('select count(*) as n from run_messages where "runId"=$1', [runId])).rows[0].n), 1)
      assert.deepEqual(await queueRun(f.userId, input, coordinator, undefined, eventId), { runId }, 'old host replay preserves the already accepted execution')
      assert.equal((await prepareRunPublication(accepted, f.remoteUrl)).policy.permissions.git_push, 'allow', 'old admitted scope survives later revocation')
      await assert.rejects(prepareRunPublication({ ...accepted, deviceId: randomUUID() }, f.remoteUrl), /does not match/)
      const nextIssue = randomUUID(), nextEvent = randomUUID()
      await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'New prompt\',$3,\'todo\',\'normal\',\'personal\')', [nextIssue, f.userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 2 } }, content: [] })])
      await pool.query('insert into coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload,"deliveredAt") values ($1,$2,\'user_message\',$5,$3,$4,now())', [nextEvent, f.userId, nextIssue, JSON.stringify({ taskDestination: { kind: 'device', deviceId: f.deviceId } }), 'admission:' + nextEvent])
      await assert.rejects(queueRun(f.userId, { ...input, issueId: nextIssue }, null, undefined, nextEvent), /runInvalid/)
      await stopOwnedRun(db, f.userId, runId)
      assert.ok((await pool.query('select "stopRequestedAt" from agent_runs where id=$1', [runId])).rows[0].stopRequestedAt)

      // Actual Postgres contention: admission must wait behind revocation's lock.
      await writeRepositoryPushApproval(f.userId, f.remoteKey, true)
      const locker = await pool.connect()
      let attempt: Promise<unknown> | undefined
      try {
        await locker.query('begin')
        const pid = (await locker.query('select pg_backend_pid() as pid')).rows[0].pid
        await locker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['repository-approval', f.userId, f.remoteKey])])
        attempt = queueRun(f.userId, { ...input, issueId: nextIssue }, null, undefined, nextEvent)
        const settled = attempt.then(() => ({ accepted: true }), error => ({ accepted: false, error }))
        let blocked = false
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await pool.query('select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked', [pid])).rows[0].blocked
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(blocked, true, 'admission really waits for the repository approval lock')
        await locker.query('update repository_settings set push=$3 where "userId"=$1 and "remoteKey"=$2', [f.userId, f.remoteKey, JSON.stringify({ approved: false })])
        await locker.query('commit')
        const result = await settled
        assert.equal(result.accepted, false)
        assert.ok('error' in result && result.error instanceof Error && result.error.message === 'runInvalid')
      } finally {
        await locker.query('rollback')
        locker.release()
        await attempt?.catch(() => {})
      }
      assert.equal(Number((await pool.query('select count(*) as n from agent_runs where "userId"=$1', [f.userId])).rows[0].n), before + 2, 'only the admitted execution and the explicit legacy fixture were added')
    })

    await t.test('Plugins › GitHub: 推送分支 is the run policy the token issuer reads; 创建 Pull Request deny blocks, ask waits on one card, allow opens', async () => {
      const { readGitHubPermissions, setGitHubPermissions } = await import('../lib/github/plugin-permissions')
      // The runs here name no bot; they are the personal workspace's Coordinator's, whose settings these are.
      const home = async (userId: string) => (await (await import('../lib/coordinator/coordinator-bot')).coordinatorBot(userId, null)).workspaceId
      const { readCliRunPolicy } = await import('../lib/agent-tool-approval/policy-store')
      const { decidePendingAction } = await import('../lib/pending-actions')
      const ready = async () => {
        const f = await fixture({ approved: true })
        await prepareRunPublication(assignment(f), f.remoteUrl)
        assert.equal((await persistRunCompletion(f.userId, f.runId, completion(f)))?.publicationPending, true)
        return f
      }
      const never: OpenPullRequest = async () => { throw new Error('A denied or unanswered pull request must never reach GitHub') }
      const cards = async (f: Fixture) => (await pool.query(`select id,status,input from pending_actions where "userId"=$1 and action='approve_pull_request'`, [f.userId])).rows

      // 推送分支: the Coordinator's own git_push, the value authorizeRunGitHubToken refuses on deny.
      const pushed = await ready()
      assert.equal((await readCliRunPolicy(pool, pushed.runId, pushed.userId)).policy.permissions.git_push, 'ask')
      let settings = await setGitHubPermissions(pool, pushed.userId, await home(pushed.userId), { version: (await readGitHubPermissions(pool, pushed.userId, await home(pushed.userId))).version, push: 'deny' })
      assert.equal((await readCliRunPolicy(pool, pushed.runId, pushed.userId)).policy.permissions.git_push, 'deny')
      settings = await setGitHubPermissions(pool, pushed.userId, await home(pushed.userId), { version: settings.version, push: 'allow' })
      assert.equal((await readCliRunPolicy(pool, pushed.runId, pushed.userId)).policy.permissions.git_push, 'allow')
      await assert.rejects(setGitHubPermissions(pool, pushed.userId, await home(pushed.userId), { version: '0:0', push: 'deny' }), { code: 'githubPermissionsChanged' })
      // Unset 创建 Pull Request keeps today's behaviour: the approved push opens it.
      assert.deepEqual(await publishRunResult(pushed.runId, async () => prFor(pushed)), { done: true })
      assert.equal((await receipt(pushed)).status, 'published')

      const denied = await ready()
      await setGitHubPermissions(pool, denied.userId, await home(denied.userId), { version: '0:0', pullRequest: 'deny' })
      assert.deepEqual(await publishRunResult(denied.runId, never), { done: true })
      assert.equal((await receipt(denied)).status, 'blocked')
      assert.equal((await receipt(denied)).errorCode, 'pull_request_denied')
      assert.equal((await event(denied)).payload.publication.errorCode, 'pull_request_denied')
      assert.deepEqual(await cards(denied), [])

      const asked = await ready()
      await setGitHubPermissions(pool, asked.userId, await home(asked.userId), { version: '0:0', pullRequest: 'ask' })
      assert.deepEqual(await publishRunResult(asked.runId, never), { done: true })
      assert.equal((await receipt(asked)).status, 'awaiting_approval')
      assert.deepEqual(await publishRunResult(asked.runId, never), { done: true }, 'a duplicate workflow stops while the card waits')
      const [card, ...extra] = await cards(asked)
      assert.equal(extra.length, 0)
      assert.equal(card.status, 'pending')
      assert.deepEqual(card.input, { runId: asked.runId, repo: asked.remoteKey.split('/').slice(2).join('/'), branch: asked.branch, title: 'Fix redirect' })
      assert.deepEqual(await counts(asked), { versions: 0, events: 0 }, 'nothing is reported done while the card waits')
      const other = await fixture()
      await assert.rejects(decidePendingAction(other.userId, card.id, true, async () => {}))
      const restarted: string[] = []
      assert.deepEqual(await decidePendingAction(asked.userId, card.id, true, async runId => { restarted.push(runId) }), { status: 'done', error: null })
      assert.deepEqual(restarted, [asked.runId])
      assert.equal((await receipt(asked)).status, 'pending')
      let opened = 0
      assert.deepEqual(await publishRunResult(asked.runId, async () => { opened++; return prFor(asked) }), { done: true })
      assert.equal(opened, 1)
      assert.equal((await receipt(asked)).status, 'published')
      assert.deepEqual((await event(asked)).payload.publication.pullRequest, prFor(asked))
      await assert.rejects(decidePendingAction(asked.userId, card.id, false, async () => {}), 'a decided card cannot be decided again')

      const declined = await ready()
      await setGitHubPermissions(pool, declined.userId, await home(declined.userId), { version: '0:0', pullRequest: 'ask' })
      await publishRunResult(declined.runId, never)
      const [declinedCard] = await cards(declined)
      await decidePendingAction(declined.userId, declinedCard.id, false, async () => {})
      assert.deepEqual(await publishRunResult(declined.runId, never), { done: true })
      assert.equal((await receipt(declined)).errorCode, 'pull_request_declined')

      // Approved, then turned to deny before the restart: deny wins.
      const revoked = await ready()
      let revokedSettings = await setGitHubPermissions(pool, revoked.userId, await home(revoked.userId), { version: '0:0', pullRequest: 'ask' })
      await publishRunResult(revoked.runId, never)
      const [revokedCard] = await cards(revoked)
      await decidePendingAction(revoked.userId, revokedCard.id, true, async () => {})
      revokedSettings = await setGitHubPermissions(pool, revoked.userId, await home(revoked.userId), { version: revokedSettings.version, pullRequest: 'deny' })
      assert.deepEqual(await publishRunResult(revoked.runId, never), { done: true })
      assert.equal((await receipt(revoked)).errorCode, 'pull_request_denied')
    })
  } finally {
    // Fixture rows and audit history remain; credential invalidation is non-deleting.
    if (fixtures.length) await pool.query('update run_tokens set "revokedAt"=coalesce("revokedAt",now()) where "userId"=any($1::text[])', [fixtures.map(row => row.userId)])
    await pool.end()
    const workspacePool = (globalThis as { workspacePool?: { end(): Promise<void> } }).workspacePool
    if (workspacePool) await workspacePool.end()
  }
})
