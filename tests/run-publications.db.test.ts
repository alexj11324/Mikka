import { seedFixtureWorkspace } from './helpers/task-workspace'
// Next captures AsyncLocalStorage when its work stores are first imported.
import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { RunCompleteRequest } from '@mikka/protocol/run'
import type { RunFailure } from '@mikka/protocol/run-failure'
import { APP_BUILD } from '../lib/app-build'
import { measured, readMetrics } from './helpers/read-metrics'
import type { PublishedPullRequest } from '../lib/run-publication-result'
import type { OwnerPullRequestOpener } from '../lib/run-publications'
import { remoteKey as repositoryKey } from '@mikka/protocol/repository'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const connection = process.env.E2E_DATABASE_URL
const enabled = disposableDatabase()
if (connection) {
  if (!enabled) throw new Error('Run publication DB tests require a loopback *_e2e database')
  if (process.env.MIKKA_DATABASE_URL !== connection || process.env.DATABASE_URL !== connection || (process.env.ORVILO_DATABASE_URL && process.env.ORVILO_DATABASE_URL !== connection)) throw new Error('All publication test database paths must use the ephemeral E2E_DATABASE_URL')
}
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Run publication DB tests cannot skip in required CI')

type Fixture = {
  workspaceId: string; userId: string; deviceId: string; agentId: string; repoId: string; issueId: string; runId: string
  remoteUrl: string; remoteKey: string; identifier: string; branch: string; githubAccountId: string
  /** The receipt admission wrote from the GitHub App grant, when the fixture is admitted to push. */
  admission?: Record<string, unknown>
}
type OpenPullRequest = OwnerPullRequestOpener

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
  const { db, pool } = await import('../lib/db')
  const { prepareRunPublication, persistRunCompletion, publishRunResult } = await import('../lib/run-publications')
  const { PublicationError } = await import('../lib/run-publication-result')
  const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
  const fixtures: Fixture[] = []
  let githubId = 800_000

  const assignment = (fixture: Fixture) => ({ id: fixture.runId, userId: fixture.userId, issueId: fixture.issueId, baseBranch: null, deviceId: fixture.deviceId, agentId: fixture.agentId, botId: null,
    agentDefinition: fixture.admission ? { repositoryAdmission: fixture.admission } as never : null })
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
  // Push authority is the receipt admission writes from the GitHub App grant (lib/github/push-grant.ts).
  const admit = async (fixture: Fixture, overrides: Record<string, unknown> = {}) => {
    const now = new Date().toISOString()
    fixture.admission = { userId: fixture.userId, issueId: fixture.issueId, deviceId: fixture.deviceId, agentId: fixture.agentId, remoteKey: fixture.remoteKey, remoteUrl: fixture.remoteUrl,
      permission: 'push_to_origin', targetBranch: fixture.branch, approvedAt: now, authority: 'github_app', acceptedAt: now, ...overrides }
    await pool.query('update agent_runs set "agentDefinition"=$2 where id=$1', [fixture.runId, JSON.stringify({ repositoryAdmission: fixture.admission })])
  }
  const fixture = async (options: { approved?: boolean; prefix?: string; number?: number; remoteKey?: string; remoteUrl?: string; scope?: 'personal' | 'workspace' } = {}) => {
    const seed = randomUUID()
    const prefix = options.prefix ?? 'TEST'
    const number = options.number ?? 1
    const remoteKey = options.remoteUrl ? repositoryKey(options.remoteUrl) : options.remoteKey ?? `v2/github.com/mikka-ci/repo-${seed}`
    const row: Fixture = {
      userId: `publication-${seed}`, deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), issueId: randomUUID(), runId: randomUUID(),
      workspaceId: randomUUID(), remoteUrl: options.remoteUrl ?? `https://${remoteKey.slice(3)}.git`, remoteKey, identifier: `${prefix}-${number}`, branch: `mikka/${prefix.toLowerCase()}-${number}`, githubAccountId: String(++githubId),
    }
    fixtures.push(row)
    await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [row.userId, `${row.userId}@example.invalid`])
    await seedFixtureWorkspace(pool, row.userId, options.scope === 'workspace' ? 'team' : 'personal', row.workspaceId)
    await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,$2)', [row.userId, prefix])
    await pool.query('insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values ($1,$2,\'github\',$3,now(),now())', [randomUUID(), row.githubAccountId, row.userId])
    await pool.query('insert into devices (id,"ownerId",name,kind,harnesses) values ($1,$2,\'Publication CI computer\',\'local\',$3)', [row.deviceId, row.userId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('insert into agents (id,"userId","deviceId",harness,name) values ($1,$2,$3,\'codex\',$4)', [row.agentId, row.userId, row.deviceId, `codex ${row.deviceId}`])
    await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") values ($1,$2,$3,$4,$5,null)', [row.repoId, row.deviceId, row.userId, row.remoteKey, row.remoteUrl])
    const { rows: [createdTask] } = await pool.query('insert into issues (id,"userId","workspaceId",title,content,status,priority,scope) values ($1,$2,$5,\'Fix redirect\',$3,\'todo\',\'normal\',$4) returning "issuedIdentifier"', [row.issueId, row.userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original task body' }] }] }), options.scope ?? 'personal', row.workspaceId])
    if (options.scope === 'workspace') {
      assert.equal(createdTask.issuedIdentifier, `W${row.workspaceId.replaceAll('-', '').slice(0, 12).toUpperCase()}-1`)
      row.identifier = createdTask.issuedIdentifier
      row.branch = `mikka/${row.identifier.toLowerCase()}`
    }
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt) values ($1,$2,$3,$4,$5,$6,\'running\',\'implement\',null,\'Fix redirect\')', [row.runId, row.userId, row.issueId, row.agentId, row.deviceId, row.repoId])
    await pool.query('insert into run_tokens (id,"runId","userId","tokenHash","expiresAt") values ($1,$2,$3,$4,now()+interval \'1 hour\')', [randomUUID(), row.runId, row.userId, `synthetic-${randomUUID()}`])
    if (options.approved) await admit(row)
    return row
  }

  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')

    await t.test('runtime failure details survive an independent connection and first-completion replay', async () => {
      const { Client } = await import('pg')
      const { visibleRuns } = await import('../lib/agent-runs')
      const { newestTaskRuns } = await import('../lib/task-block-runs')
      const f = await fixture()
      const before = await visibleRuns(f.userId, { issueId: f.issueId, teams: [] })
      assert.equal(before[0]?.failureDetails, null, 'old rows have no invented diagnostic')
      const failureDetails: RunFailure = { schemaVersion: 1, code: 'run_api_key_invalid', category: 'api_key', provider: 'openai', status: 401,
        providerMessage: 'Provider fixture: authentication refused for this account', causes: [{ name: 'APIError', code: 'invalid_api_key' }],
        recovery: 'configure_api_key', runId: 'untrusted-run', appVersion: 'untrusted-version', occurredAt: '2026-11-07T12:00:00.000Z' }
      await persistRunCompletion(f.userId, f.runId, { stopReason: 'error', failureDetails })
      const reload = new Client({ connectionString: connection })
      await reload.connect()
      let stored: RunFailure
      try {
        const { rows: [row] } = await reload.query('select status,"failureDetails" from agent_runs where id=$1', [f.runId])
        assert.equal(row.status, 'failed')
        stored = row.failureDetails
        assert.equal(stored.runId, f.runId)
        assert.equal(stored.appVersion, APP_BUILD || 'unknown')
        assert.equal(stored.providerMessage, failureDetails.providerMessage)
      } finally { await reload.end() }
      const full = await measured(() => visibleRuns(f.userId, { issueId: f.issueId, teams: [] }))
      const brief = await measured(() => visibleRuns(f.userId, { issueId: f.issueId, teams: [], brief: true }))
      assert.deepEqual(full.value[0].failureDetails, stored!)
      assert.equal(brief.value[0].failureDetails?.code, 'run_api_key_invalid')
      assert.equal(Object.hasOwn(brief.value[0].failureDetails!, 'providerMessage'), false)
      assert.equal(Object.hasOwn(brief.value[0].failureDetails!, 'causes'), false)
      assert.equal(brief.statements, full.statements, 'brief reads use the existing query budget')
      assert.ok(brief.resultBytes < full.resultBytes)
      const blocks = await newestTaskRuns(f.userId, [f.issueId])
      assert.equal(blocks[0]?.failureDetails?.code, 'run_api_key_invalid')
      assert.doesNotMatch(JSON.stringify(blocks), /Provider fixture|APIError/)
      await Promise.all([
        persistRunCompletion(f.userId, f.runId, { stopReason: 'cancelled' }),
        persistRunCompletion(f.userId, f.runId, { stopReason: 'error', failureDetails: { ...failureDetails, code: 'run_quota_exceeded', category: 'quota' } }),
      ])
      const current = (await pool.query('select status,"failureDetails" from agent_runs where id=$1', [f.runId])).rows[0]
      assert.equal(current.status, 'failed')
      assert.deepEqual(current.failureDetails, stored!)
      assert.deepEqual(await counts(f), { versions: 0, events: 1 })
    })

    await t.test('normal completion clears stale diagnostics while failed verification stores a generic code', async () => {
      const failureDetails: RunFailure = { schemaVersion: 1, code: 'run_quota_exceeded', category: 'quota', providerMessage: 'Must not label a normal completion', causes: [],
        runId: null, appVersion: 'worker', occurredAt: '2026-11-07T12:00:00.000Z' }
      for (const stopReason of ['cancelled', 'submitted'] as const) {
        const f = await fixture()
        await pool.query('update agent_runs set "failureDetails"=$2 where id=$1', [f.runId, JSON.stringify(failureDetails)])
        await persistRunCompletion(f.userId, f.runId, { ...completion(f), stopReason, failureDetails })
        assert.equal((await pool.query('select "failureDetails" from agent_runs where id=$1', [f.runId])).rows[0].failureDetails, null)
      }
      for (const stopReason of ['submitted', 'blocked'] as const) {
        const f = await fixture()
        const submitted = completion(f)
        await persistRunCompletion(f.userId, f.runId, { ...submitted, stopReason, failureDetails, report: { ...submitted.report!, verify: { status: 'failed' } } })
        const row = (await pool.query('select status,"failureDetails" from agent_runs where id=$1', [f.runId])).rows[0]
        assert.equal(row.status, stopReason === 'submitted' ? 'failed' : 'stopped')
        if (stopReason === 'submitted') {
          assert.equal(row.failureDetails.code, 'run_failed')
          assert.equal(row.failureDetails.providerMessage, undefined)
        } else assert.equal(row.failureDetails, null)
      }
    })

    await t.test('device completion and server terminal transitions persist diagnostics under their existing fences', async () => {
      const { completeRunForDevice } = await import('../lib/run-completion')
      const { failRunForDaemonUpgrade } = await import('../lib/run-leases')
      const { AfterContext } = await import('next/dist/server/after/after-context')
      const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external')
      const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external')
      const { createRequestStoreForAPI } = await import('next/dist/server/async-storage/request-store')
      const { NextRequest } = await import('next/server')
      // Like issue-scope-detachment.db.test.ts, supply Next's real request
      // lifecycle and drain after() work without replacing any database writer.
      async function failFromRequest(...args: Parameters<typeof failRunForDaemonUpgrade>) {
        const waits: Promise<unknown>[] = [], errors: unknown[] = [], closes: Array<() => void> = []
        const afterContext = new AfterContext({ waitUntil: promise => { waits.push(promise) }, onClose: close => { closes.push(close) }, onTaskError: error => { errors.push(error) } })
        const request = new NextRequest(`http://127.0.0.1/mikka/v1/runs/${args[0]}/complete`)
        const requestStore: ReturnType<typeof createRequestStoreForAPI> = Reflect.apply(createRequestStoreForAPI, undefined, [request, new URL(request.url), { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined])
        return workAsyncStorage.run({ afterContext } as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () => workUnitAsyncStorage.run(requestStore, async () => {
          try { return await failRunForDaemonUpgrade(...args) }
          finally { for (const close of closes) close(); await Promise.all(waits); assert.deepEqual(errors, []) }
        }))
      }
      const f = await fixture()
      const stranger = await fixture()
      assert.equal(await completeRunForDevice(stranger.userId, { id: f.runId, issueId: f.issueId }, { stopReason: 'timeout' }), null)
      assert.ok(await completeRunForDevice(f.userId, { id: f.runId, issueId: f.issueId }, { stopReason: 'timeout' }))
      const first = (await pool.query('select "failureDetails" from agent_runs where id=$1', [f.runId])).rows[0].failureDetails
      assert.equal(first.code, 'run_timeout')
      assert.equal(first.runId, f.runId)
      assert.equal(await completeRunForDevice(f.userId, { id: f.runId, issueId: f.issueId }, { stopReason: 'error' }), null)
      assert.deepEqual((await pool.query('select "failureDetails" from agent_runs where id=$1', [f.runId])).rows[0].failureDetails, first)
      const queued = await fixture()
      await pool.query("update agent_runs set status='queued' where id=$1", [queued.runId])
      assert.equal(await failFromRequest(queued.runId, stranger.deviceId, queued.userId), false)
      assert.equal(await failFromRequest(queued.runId, queued.deviceId, stranger.userId), false)
      assert.equal(await failFromRequest(queued.runId, queued.deviceId, queued.userId), true)
      assert.equal((await pool.query('select "failureDetails" from agent_runs where id=$1', [queued.runId])).rows[0].failureDetails.code, 'run_failed')
      assert.equal(await failFromRequest(queued.runId, queued.deviceId, queued.userId), false)
    })

    await t.test('an unlinked workspace task publishes its immutable Workspace identifier without changing scope', async () => {
      const { admitCloudPush } = await import('../lib/computer/cloud-push')
      const { workspacePool } = await import('../lib/workspace-db')
      const { seedTeam } = await import('./support/workspace-admin-db')
      const f = await fixture({ approved: true, prefix: 'MINE', number: 12, scope: 'workspace' })
      const linked = await fixture({ approved: true, prefix: 'OTHR', number: 18, scope: 'workspace' })
      const workspaceId = linked.workspaceId
      const { id: teamId } = await seedTeam(workspacePool, workspaceId, linked.userId, 'Publication budget CI')
      await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [linked.issueId, teamId, workspaceId, linked.userId])
      const client = await pool.connect()
      // The internal helper is measured after the caller's admission. Grouping
      // cannot change a previously issued identifier or its repository branch.
      const cloudAdmission = (row = f) => admitCloudPush(client, { userId: row.userId, issueId: row.issueId, agentId: row.agentId, deviceId: row.deviceId, deviceRepoId: row.repoId, workspaceId: row.workspaceId, now: new Date() })
      try {
        await client.query('BEGIN')
        const admitted = await measured(() => cloudAdmission())
        const linkedCloud = await measured(() => cloudAdmission(linked))
        assert.ok(admitted.value, 'a task without a local team still gets a publication receipt')
        assert.equal(admitted.value.publication.identifier, f.identifier)
        assert.equal(admitted.value.publication.branch, f.branch)
        assert.equal(admitted.value.publication.remoteUrl, f.remoteUrl)
        assert.equal(linkedCloud.value?.publication.identifier, linked.identifier)
        assert.equal(admitted.statements, linkedCloud.statements, 'first cloud admission keeps the linked-task query budget')
        await client.query('COMMIT')
        const prepared = await measured(() => prepareRunPublication(assignment(f), f.remoteUrl))
        const linkedPrepared = await measured(() => prepareRunPublication(assignment(linked), linked.remoteUrl))
        assert.equal(prepared.value.pushBranch, f.branch)
        assert.equal(prepared.statements, linkedPrepared.statements, 'first publication keeps the linked-task query budget')
        assert.equal((await receipt(f)).identifier, f.identifier)
        await pool.query('update issue_prefixes set prefix=\'NEXT\' where "userId"=$1', [f.userId])
        await client.query('BEGIN')
        const frozen = await measured(() => cloudAdmission())
        assert.equal(frozen.value?.publication.branch, f.branch, 'a later prefix edit does not move the existing PR branch')
        assert.equal(frozen.value?.publication.identifier, f.identifier)
        assert.equal(frozen.statements, admitted.statements, 'both paths reuse the selected immutable identifier without a helper query')
        await client.query('COMMIT')
        await pool.query('update run_publications set identifier=null where "runId"=$1', [f.runId])
        await client.query('BEGIN')
        const repaired = await cloudAdmission()
        assert.equal(repaired?.publication.identifier, f.identifier, 'a null receipt identifier reuses the original issued identity')
        assert.equal(repaired?.publication.branch, f.branch, 'filling an identifier does not replace the frozen branch')
        await client.query('COMMIT')
        await pool.query('update run_publications set identifier=$2 where "runId"=$1', [f.runId, f.identifier])
        assert.equal((await task(f)).scope, 'workspace')
        assert.equal((await task(f)).userId, f.userId)
        assert.equal((await task(f)).issuedIdentifier, f.identifier)
        assert.equal((await task(linked)).issuedIdentifier, linked.identifier)
        assert.equal((await workspacePool.query('select count(*)::int n from mikka_team_issues where "issueId"=$1', [f.issueId])).rows[0].n, 0, 'naming does not assign a team or change access')
        console.log('Publication identifier read budget:', JSON.stringify({
          cloud: { unlinked: admitted.statements, linked: linkedCloud.statements, frozen: frozen.statements, resultBytes: admitted.resultBytes },
          publication: { unlinked: prepared.statements, linked: linkedPrepared.statements, resultBytes: prepared.resultBytes },
        }))
      } finally {
        await client.query('ROLLBACK')
        client.release()
        console.log('Publication read-budget fixture retention:', JSON.stringify({ retention: 'preserve', workspaceId, teamId, linkedIssueId: linked.issueId }))
      }
    })

    await t.test('identifier transport stays observable for empty and short tasks across team states', async t => {
      const { admitCloudPush } = await import('../lib/computer/cloud-push')
      const { workspacePool } = await import('../lib/workspace-db')
      const { withTaskWorkspace } = await import('../lib/task-workspace')
      const { withRunWorkspace } = await import('../lib/run-completion')
      const { ActionFailureError } = await import('../lib/action-error')
      const { seedTeam } = await import('./support/workspace-admin-db')
      const { searchIssues, parseSearchParams } = await import('../lib/issue-search')
      const { listArtifacts } = await import('../lib/artifacts/store')
      const samples: Array<{ body: string; teamState: string; search: ReturnType<typeof readMetrics>; artifacts: ReturnType<typeof readMetrics>; cloud: ReturnType<typeof readMetrics>; publication: ReturnType<typeof readMetrics>; frozen: ReturnType<typeof readMetrics> }> = []
      for (const body of ['empty', 'short'] as const) for (const teamState of ['linked', 'unlinked', 'revoked-owner'] as const) {
        const f = await fixture({ approved: true, prefix: 'MTRX', number: 12, scope: 'workspace' })
        const workspaceId = f.workspaceId
        await pool.query('update issues set content=$2 where id=$1', [f.issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 12 } }, content: body === 'empty' ? [] : [{ type: 'paragraph', content: [{ type: 'text', text: 'Short task body' }] }] })])
        if (teamState !== 'unlinked') {
          const { id: teamId } = await seedTeam(workspacePool, workspaceId, f.userId, 'Identifier transport CI')
          await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [f.issueId, teamId, workspaceId, f.userId])
        }
        const artifactId = randomUUID()
        await pool.query('insert into artifacts (id,"userId","workspaceId",kind,title,"issueId","latestVersion") values ($1,$2,$4,\'markdown\',\'Transport fixture\',$3,1)', [artifactId, f.userId, f.issueId, workspaceId])
        await pool.query('insert into artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") values ($1,$2,1,$3,\'fixture\',\'fixture\',7,\'CI\')', [randomUUID(), artifactId, `ci/identifier-transport/${artifactId}.md`])
        if (teamState === 'revoked-owner') {
          // Preserve a real pre-revocation receipt. Neither cached naming nor
          // authorship authorizes new admission or publication after suspension.
          await prepareRunPublication(assignment(f), f.remoteUrl)
          await workspacePool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspaceId, f.userId])
        }
        const search = () => searchIssues(db, { userId: f.userId, workspaceId, params: parseSearchParams(new URLSearchParams({ q: 'Fix redirect' })) })
        await search()
        await listArtifacts(f.userId)
        const searched = await measured(search)
        const artifacts = await measured(() => listArtifacts(f.userId))
        if (teamState === 'revoked-owner') {
          const before = { task: await task(f), receipt: await receipt(f), counts: await counts(f) }
          let admissions = 0
          const cloudAdmission = async () => {
            admissions++
            const client = await pool.connect()
            try {
              await client.query('BEGIN')
              return await admitCloudPush(client, { userId: f.userId, issueId: f.issueId, agentId: f.agentId, deviceId: f.deviceId, deviceRepoId: f.repoId, workspaceId, now: new Date() })
            } finally { await client.query('ROLLBACK'); client.release() }
          }
          const guardedCloud = () => withTaskWorkspace(f.userId, workspaceId, cloudAdmission)
          assert.equal(await withRunWorkspace(f.userId, workspaceId, cloudAdmission), null, 'the normal Run boundary denies revoked membership before APP admission')
          const deniedCloud = async () => {
            await assert.rejects(guardedCloud, error => error instanceof ActionFailureError && error.code === 'workspaceAccessDenied')
            return { error: 'workspaceAccessDenied' }
          }
          const admitted = await measured(deniedCloud)
          const prepared = await measured(async () => {
            await assert.rejects(() => prepareRunPublication(assignment(f), f.remoteUrl), error => error instanceof PublicationError && error.code === 'issue_unavailable')
            return { error: 'issue_unavailable' }
          })
          const frozen = await measured(deniedCloud)
          const sample = { body, teamState, search: readMetrics(searched), artifacts: readMetrics(artifacts), cloud: readMetrics(admitted), publication: readMetrics(prepared), frozen: readMetrics(frozen) }
          samples.push(sample)
          t.diagnostic(JSON.stringify({ event: 'identifier_transport_matrix', ...sample }))
          assert.deepEqual(searched.value.items, [])
          assert.deepEqual(artifacts.value, [])
          assert.equal(admissions, 0, 'current Workspace denial occurs before the APP admission transaction')
          assert.deepEqual({ task: await task(f), receipt: await receipt(f), counts: await counts(f) }, before, 'denial does not rewrite the Task, its frozen publication or history')
          assert.doesNotMatch(JSON.stringify([searched.value, artifacts.value]), /prefixInput|__mikkaIdentifierPrefix|@example\.invalid/)
          continue
        }
        const client = await pool.connect()
        const cloud = () => admitCloudPush(client, { userId: f.userId, issueId: f.issueId, agentId: f.agentId, deviceId: f.deviceId, deviceRepoId: f.repoId, workspaceId, now: new Date() })
        try {
          await client.query('BEGIN')
          const admitted = await measured(cloud)
          await client.query('COMMIT')
          const prepared = await measured(() => prepareRunPublication(assignment(f), f.remoteUrl))
          await client.query('BEGIN')
          const frozen = await measured(cloud)
          await client.query('COMMIT')
          const sample = { body, teamState, search: readMetrics(searched), artifacts: readMetrics(artifacts), cloud: readMetrics(admitted), publication: readMetrics(prepared), frozen: readMetrics(frozen) }
          samples.push(sample)
          t.diagnostic(JSON.stringify({ event: 'identifier_transport_matrix', ...sample }))
          assert.equal(searched.value.items.find(row => row.id === f.issueId)?.identifier, f.identifier)
          assert.equal(artifacts.value.find(row => row.issueId === f.issueId)?.issueKey, f.identifier)
          assert.equal(admitted.value?.publication.identifier, f.identifier)
          assert.equal(prepared.value.pushBranch, f.branch)
          assert.equal(frozen.value?.publication.identifier, f.identifier)
          assert.doesNotMatch(JSON.stringify([searched.value, artifacts.value]), /prefixInput|__mikkaIdentifierPrefix|@example\.invalid/)
        } finally {
          await client.query('ROLLBACK')
          client.release()
        }
      }
      for (const body of ['empty', 'short']) {
        const linked = samples.find(row => row.body === body && row.teamState === 'linked')!
        const unlinked = samples.find(row => row.body === body && row.teamState === 'unlinked')!
        for (const surface of ['search', 'artifacts', 'cloud', 'publication'] as const) {
          if (surface === 'search') assert.ok(unlinked[surface].databaseStatements <= linked[surface].databaseStatements, `${body} ${surface} does not exceed the linked statement budget`)
          else if (surface === 'artifacts') assert.ok(unlinked[surface].databaseStatements <= 4 && linked[surface].databaseStatements <= 5, `${body} ${surface} does not exceed the linked statement budget`)
          else assert.equal(unlinked[surface].databaseStatements, linked[surface].databaseStatements, `${body} ${surface} keeps the linked statement budget`)
        }
      }
    })

    await t.test('a run that ends during human control accepts its terminal report and clears pause metadata', async () => {
      const f = await fixture()
      await pool.query(`UPDATE agent_runs SET status='paused',"pauseReason"='human_control',"resumeStatus"='running' WHERE id=$1`, [f.runId])
      const result = await persistRunCompletion(f.userId,f.runId,{stopReason:'timeout'})
      assert.ok(result)
      const ended = (await pool.query('SELECT status,"pauseReason","resumeStatus" FROM agent_runs WHERE id=$1',[f.runId])).rows[0]
      assert.deepEqual(ended,{status:'failed',pauseReason:null,resumeStatus:null})
    })

    await t.test('a read-only investigation completes and returns one report without a verification or publication receipt', async () => {
      const f = await fixture()
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.runId, JSON.stringify({ readOnly: true })])
      const report = { summary: 'Found the root cause; no files changed.', filesChanged: [], verify: { status: 'not_run' as const }, openQuestions: [], nextStep: null }
      const result = await persistRunCompletion(f.userId, f.runId, { stopReason: 'submitted', report })
      assert.equal(result?.publicationPending, false)
      const saved = (await pool.query('SELECT status,report FROM agent_runs WHERE id=$1', [f.runId])).rows[0]
      assert.deepEqual(saved, { status: 'succeeded', report })
      assert.equal((await event(f)).payload.summary, report.summary)
      assert.equal((await counts(f)).events, 1)
      assert.equal(await receipt(f), undefined)
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
        assert.equal(input.userId, f.userId, 'the pull request opens with the run owner\'s own credential')
        assert.equal(input.remoteKey, f.remoteKey)
        assert.equal(input.issueId, f.issueId)
        assert.equal(input.branch, f.branch)
        assert.equal(input.commit, 'a'.repeat(40))
        assert.equal(input.allowCreate, true)
        entered.resolve()
        await release.promise
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

    await t.test('unverified work without a matching push cannot succeed or advance the task', async () => {
      for (const mode of ['not-pushed', 'wrong-branch'] as const) {
        const f = await fixture({ approved: true })
        await prepareRunPublication(assignment(f), f.remoteUrl)
        const submitted = completion(f, 'Unverified submission')
        submitted.report!.verify = { status: 'not_run' }
        submitted.report!.deliverableCommit = 'f'.repeat(40) // A report cannot turn repository work into a host-authorized deliverable.
        if (mode === 'not-pushed') submitted.report!.publish!.pushed = false
        if (mode === 'wrong-branch') submitted.report!.publish!.branch = 'main'
        assert.equal((await persistRunCompletion(f.userId, f.runId, submitted))?.publicationPending, false)
        const run = (await pool.query('select status,report from agent_runs where id=$1', [f.runId])).rows[0]
        assert.equal(run.status, 'stopped')
        assert.equal(run.report.verify.status, 'not_run')
        assert.equal((await task(f)).status, 'todo')
        assert.equal((await receipt(f)).status, 'blocked')
        assert.equal((await receipt(f)).pullRequest, null)
        await publishRunResult(f.runId, async () => { throw new Error('Unpushed unverified work must never reach GitHub') })
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
      await assert.rejects(prepareRunPublication({ ...assignment(owner), userId: stranger.userId, agentDefinition: null }, owner.remoteUrl), { code: 'issue_unavailable' })
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

    await t.test('a push receipt for another endpoint, a legacy key or without a grant lends nothing', async () => {
      const f = await fixture({ remoteUrl: 'https://git.example.com:9443/team/repo.git' })
      await admit(f, { remoteKey: repositoryKey('https://git.example.com:8443/Team/Repo.git') })
      await assert.rejects(prepareRunPublication(assignment(f), f.remoteUrl), { code: 'publication_mismatch' })
      const legacy = await fixture()
      await admit(legacy, { remoteKey: legacy.remoteKey.slice(3) })
      await assert.rejects(prepareRunPublication(assignment(legacy), legacy.remoteUrl), { code: 'publication_mismatch' }, 'old GitHub keys are not this repository')
      const configured = await fixture()
      await admit(configured, { authority: 'configured_allow', approvedAt: undefined })
      await assert.rejects(prepareRunPublication(assignment(configured), configured.remoteUrl), { code: 'publication_mismatch' }, 'a configured allow never stood for a grant')
      const github = await fixture({ approved: true })
      assert.equal((await prepareRunPublication(assignment(github), github.remoteUrl)).policy.permissions.git_push, 'allow')
      await pool.query('UPDATE run_publications SET "remoteKey"=$2 WHERE "runId"=$1', [github.runId, github.remoteKey.slice(3)])
      await assert.rejects(prepareRunPublication(assignment(github), github.remoteUrl), { code: 'publication_mismatch' })
      await persistRunCompletion(github.userId, github.runId, completion(github))
      let opened = 0
      assert.deepEqual(await publishRunResult(github.runId, async () => { opened++; throw new Error('Legacy publication must not contact GitHub') }), { done: true })
      assert.equal(opened, 0)
      assert.equal((await receipt(github)).errorCode, 'publication_mismatch')
    })

    await t.test('a run delivers and opens its PR with no grant or approval in Mikka, whatever older Mikka settings say', async () => {
      // An old per-repository refusal in Mikka withholds nothing (decision 2026-11-02-1600).
      const f = await fixture()
      await pool.query(`insert into repository_settings ("userId","remoteKey",push) values ($1,$2,$3)`, [f.userId, f.remoteKey, JSON.stringify({ approved: false })])
      assert.equal((await prepareRunPublication(assignment(f), f.remoteUrl)).policy.permissions.git_push, 'allow')
      assert.equal((await persistRunCompletion(f.userId, f.runId, completion(f)))?.publicationPending, true)
      const owners: string[] = []
      assert.deepEqual(await publishRunResult(f.runId, async input => { owners.push(input.userId); return prFor(f) }), { done: true })
      assert.equal((await receipt(f)).status, 'published')
      assert.deepEqual(owners, [f.userId])
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
    await t.test('admission needs no grant or approval, replays its accepted execution and never blocks stop', async () => {
      const { queueRun } = await import('../lib/agent-runs')
      const { sendOwnedRunMessage, stopOwnedRun } = await import('../lib/run-control')
      const { db } = await import('../lib/db')
      const { coordinatorEnabled } = await import('../lib/coordinator/wake')
      assert.equal(await coordinatorEnabled(), false, 'this DB suite cannot invoke a real model')
      assert.equal(process.env.GITHUB_APP_ID, undefined, 'no GitHub App check is needed to admit')
      const f = await fixture({ prefix: 'ADMI' })
      // This fixture supplies historical publication/legacy-alias evidence.
      // The admission under test creates the next run, subject to the real
      // one-live-run gate; keep the original row without leaving it active.
      await pool.query('update agent_runs set status=\'succeeded\',"finishedAt"=clock_timestamp(),"leaseExpiresAt"=NULL where id=$1', [f.runId])
      await pool.query('update devices set "protocolVersion"=3 where id=$1', [f.deviceId])
      const input = { issueId: f.issueId, agentId: f.agentId, repo: f.remoteUrl, model: 'fixture-model' }
      const eventId = randomUUID()
      const coordinator = await (await import('../lib/coordinator/coordinator-bot')).chatBotId(f.userId, null, f.workspaceId)
      await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId",payload,"deliveredAt") values ($1,$2,$6,\'user_message\',$5,$3,$4,now())', [eventId, f.userId, f.issueId, JSON.stringify({ text: 'Synthetic owner task; no provider invocation', taskDestination: { kind: 'device', deviceId: f.deviceId } }), 'admission:' + eventId, coordinator])
      const before = Number((await pool.query('select count(*) as n from agent_runs where "userId"=$1', [f.userId])).rows[0].n)
      const admitted = await Promise.all([queueRun(f.userId, input, coordinator, undefined, eventId), queueRun(f.userId, input, coordinator, undefined, eventId)])
      assert.equal(admitted[0].runId, admitted[1].runId, 'host replay cannot enqueue a second execution')
      const runId = admitted[0].runId
      const accepted = (await pool.query('select * from agent_runs where id=$1', [runId])).rows[0]
      assert.equal(accepted.agentDefinition.repositoryAdmission.authority, 'owner_credential')
      assert.equal(accepted.agentDefinition.repositoryAdmission.approvedAt, undefined)
      assert.equal(accepted.agentDefinition.repositoryAdmission.requestEventId, eventId)
      assert.equal(accepted.agentDefinition.repositoryAdmission.deviceId, f.deviceId)
      assert.equal(accepted.agentDefinition.repositoryAdmission.targetBranch, f.branch)
      assert.equal(Number((await pool.query('select count(*) as n from agent_runs where "userId"=$1', [f.userId])).rows[0].n), before + 1)
      assert.equal(Number((await pool.query('select count(*) as n from pending_actions where "userId"=$1', [f.userId])).rows[0].n), 0, 'no approval card')
      assert.equal(Number((await pool.query('select count(*) as n from github_repository_installations where "userId"=$1', [f.userId])).rows[0].n), 0, 'no push grant is checked or recorded')
      await sendOwnedRunMessage(db, f.userId, { runId, text: 'Accepted' })
      await assert.rejects(queueRun(f.userId, input), /runInvalid/, 'attributed tasks cannot omit their host event')
      await assert.rejects(queueRun(f.userId, input, null, undefined, randomUUID()), /runInvalid/)
      assert.deepEqual(await queueRun(f.userId, input, coordinator, undefined, eventId), { runId }, 'old host replay preserves the already accepted execution')
      assert.equal((await prepareRunPublication(accepted, f.remoteUrl)).policy.permissions.git_push, 'allow')
      await assert.rejects(prepareRunPublication({ ...accepted, deviceId: randomUUID() }, f.remoteUrl), /does not match/)
      await assert.rejects(sendOwnedRunMessage(db, f.userId, { runId: f.runId, text: 'Finished runs cannot be reopened' }), /runNotFound/)
      await stopOwnedRun(db, f.userId, runId)
      assert.ok((await pool.query('select "stopRequestedAt" from agent_runs where id=$1', [runId])).rows[0].stopRequestedAt)
    })

    await t.test('opening the owner PR records the repository installation; a failed record never blocks the PR', async () => {
      const { createOwnerPullRequestOpener } = await import('../lib/run-publications')
      const observed = new Map<string, { creates: number; details: number }>()
      const github = (f: Fixture, installations: 'ok' | 'down', details: 'ok' | 'down' = 'ok') => {
        const [, , owner, repo] = f.remoteKey.split('/')
        const marker = `<!-- mikka-issue:${f.issueId} -->`
        const pr = { number: 9, html_url: `https://github.com/${owner}/${repo}/pull/9`, state: 'open', draft: false, merged_at: null, body: `Result\n\n${marker}`, head: { ref: f.branch, sha: 'a'.repeat(40), repo: { id: 4242 } }, base: { repo: { id: 4242 } } }
        let created = false
        const requests = { creates: 0, details: 0 }; observed.set(f.runId, requests)
        return (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input))
          assert.equal(url.origin, 'https://api.github.com')
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-owner-token', 'only the owner\'s own token')
          if (url.pathname === '/user') return Response.json({ id: Number(f.githubAccountId), login: 'owner-login' })
          if (url.pathname === `/repos/${owner}/${repo}`) return Response.json({ id: 4242, full_name: `${owner}/${repo}`, default_branch: 'main' })
          if (url.pathname === '/user/installations') return installations === 'down' ? Response.json({}, { status: 502 })
            : Response.json({ installations: [{ id: 1, app_id: 999, account: { login: owner }, suspended_at: null }, { id: 77, app_id: 123, account: { login: owner }, suspended_at: null }] })
          if (url.pathname.endsWith(`/git/ref/heads/${f.branch}`)) return Response.json({ object: { sha: 'a'.repeat(40) } })
          if (url.pathname.endsWith('/pulls') && (init?.method ?? 'GET') === 'GET') return Response.json(created ? [pr] : [])
          if (url.pathname.endsWith('/pulls')) { created = true; requests.creates++; return Response.json(pr, { status: 201 }) }
          if (url.pathname.endsWith('/pulls/9')) {
            requests.details++
            return details === 'down' ? Response.json({ message: 'synthetic-detail-secret' }, { status: 502 })
              : Response.json({ ...pr, additions: 3, deletions: 1, changed_files: 1 })
          }
          if (url.pathname.endsWith('/check-runs')) return Response.json({ total_count: 0, check_runs: [] })
          if (url.pathname.endsWith('/status')) return Response.json({ sha: 'a'.repeat(40), total_count: 0, statuses: [] })
          throw new Error(`Unexpected ${url.pathname}`)
        }) as typeof fetch
      }
      const ready = async () => {
        const f = await fixture({ approved: true })
        await prepareRunPublication(assignment(f), f.remoteUrl)
        assert.equal((await persistRunCompletion(f.userId, f.runId, completion(f)))?.publicationPending, true)
        return f
      }
      const row = async (f: Fixture) => (await pool.query('select "githubAccountId","installationId","repositoryId","pushGrantedAt" from github_repository_installations where "userId"=$1 and "remoteKey"=$2', [f.userId, f.remoteKey])).rows[0]
      const credential = (f: Fixture) => async (userId: string) => { assert.equal(userId, f.userId); return { token: 'synthetic-owner-token', githubAccountId: f.githubAccountId } }

      const f = await ready()
      assert.deepEqual(await publishRunResult(f.runId, createOwnerPullRequestOpener({ credential: credential(f), fetcher: github(f, 'ok'), env: { GITHUB_APP_ID: '123' } })), { done: true })
      assert.equal((await receipt(f)).status, 'published')
      assert.deepEqual(await row(f), { githubAccountId: f.githubAccountId, installationId: '77', repositoryId: '4242', pushGrantedAt: null })
      const full = (await receipt(f)).pullRequest
      assert.equal(full.branch, f.branch); assert.equal(full.headSha, 'a'.repeat(40))
      assert.equal(full.additions, 3); assert.equal(full.deletions, 1); assert.equal(full.changedFiles, 1)
      assert.equal(full.reviewChecks.complete, true)
      assert.deepEqual(observed.get(f.runId), { creates: 1, details: 1 })

      const down = await ready()
      const logged: string[] = []
      const original = console.error
      console.error = (line: unknown) => { logged.push(String(line)) }
      try {
        assert.deepEqual(await publishRunResult(down.runId, createOwnerPullRequestOpener({ credential: credential(down), fetcher: github(down, 'down'), env: { GITHUB_APP_ID: '123' } })), { done: true })
      } finally { console.error = original }
      assert.equal((await receipt(down)).status, 'published', 'bookkeeping never blocks the pull request')
      assert.equal(await row(down), undefined)
      assert.deepEqual(logged.map(line => JSON.parse(line)), [{ event: 'github_installation_record_failed', code: 'github_502' }])
      assert.doesNotMatch(logged.join(''), /synthetic-owner-token/)

      const optional = await ready()
      const opener = createOwnerPullRequestOpener({ credential: credential(optional), fetcher: github(optional, 'ok', 'down'), env: { GITHUB_APP_ID: '123' } })
      assert.deepEqual(await publishRunResult(optional.runId, opener), { done: true })
      const retained = await receipt(optional)
      assert.equal(retained.status, 'published', 'optional metadata failure cannot undo an already verified external publication')
      assert.equal(retained.pullRequest.url.endsWith('/pull/9'), true)
      assert.equal(retained.pullRequest.headSha, 'a'.repeat(40)); assert.equal(retained.pullRequest.branch, optional.branch)
      assert.equal(retained.pullRequest.additions, undefined); assert.equal(retained.pullRequest.changedFiles, undefined)
      assert.equal(retained.pullRequest.reviewChecks, null, 'refused metadata stays unknown')
      assert.deepEqual(await row(optional), { githubAccountId: optional.githubAccountId, installationId: '77', repositoryId: '4242', pushGrantedAt: null })
      assert.deepEqual(await publishRunResult(optional.runId, opener), { done: true }, 'database publication replay does not touch GitHub')
      assert.deepEqual(observed.get(optional.runId), { creates: 1, details: 1 })
    })

    await t.test('Plugins › GitHub settings gate nothing: a stored deny or ask still opens the pull request with no card', async () => {
      // The runs here name no bot; they are the personal workspace's Coordinator's.
      const home = async (userId: string) => (await (await import('../lib/coordinator/coordinator-bot')).coordinatorBot(userId, null)).workspaceId
      const ready = async () => {
        const f = await fixture({ approved: true })
        await prepareRunPublication(assignment(f), f.remoteUrl)
        assert.equal((await persistRunCompletion(f.userId, f.runId, completion(f)))?.publicationPending, true)
        return f
      }
      const cards = async (f: Fixture) => (await pool.query(`select id from pending_actions where "userId"=$1`, [f.userId])).rows

      // A legacy per-Bot deny and a workspace deny are both ignored.
      const denied = await ready()
      await pool.query(`update agent_kit_heads set external_write_permissions=jsonb_set(coalesce(external_write_permissions,'{}'::jsonb),'{github_pull_request}','"deny"') where owner_id=$1`, [denied.userId])
      await pool.query(`update agent_kit_heads set cli_run_policy=jsonb_set(coalesce(cli_run_policy,'{}'::jsonb),'{permissions}','{"git_push":"deny"}') where owner_id=$1`, [denied.userId])
      await pool.query(`insert into workspace_computer_policies ("workspaceId",permission,external_write_permissions,external_write_policy_version) values ($1,'allow','{"github":"deny"}',1)
        on conflict ("workspaceId") do update set external_write_permissions=excluded.external_write_permissions`, [await home(denied.userId)])
      let opened = 0
      assert.deepEqual(await publishRunResult(denied.runId, async () => { opened++; return prFor(denied) }), { done: true })
      assert.equal(opened, 1)
      assert.equal((await receipt(denied)).status, 'published')
      assert.deepEqual(await cards(denied), [])

      const legacy = await ready()
      await pool.query(`update agent_kit_heads set external_write_permissions=jsonb_set(coalesce(external_write_permissions,'{}'::jsonb),'{github_pull_request}','"ask"') where owner_id=$1`, [legacy.userId])
      assert.deepEqual(await publishRunResult(legacy.runId, async () => prFor(legacy)), { done: true })
      assert.equal((await receipt(legacy)).status, 'published')
      assert.deepEqual(await cards(legacy), [])
    })
  } finally {
    // Fixture rows and audit history remain; credential invalidation is non-deleting.
    if (fixtures.length) await pool.query('update run_tokens set "revokedAt"=coalesce("revokedAt",now()) where "userId"=any($1::text[])', [fixtures.map(row => row.userId)])
    await pool.end()
    const workspacePool = (globalThis as { workspacePool?: { end(): Promise<void> } }).workspacePool
    if (workspacePool) await workspacePool.end()
  }
})
