import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { seedTeam } from '../../tests/support/workspace-admin-db'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

const pr = 'https://github.com/o/r/pull/7'
const event = (state: 'open' | 'closed' = 'closed', merged = true) => ({
  repository: { full_name: 'o/r' },
  pull_request: { number: 7, html_url: pr, title: 'Fix the login page', state, draft: false, merged_at: merged ? '2026-11-05T00:00:00Z' : null },
})
const content = JSON.stringify({ type: 'doc', attrs: { mikka: { pullRequests: [{ url: pr, state: 'open' }] } }, content: [] })

test('the PR status key reaches each delivered task\'s audience, after the real GitHub webhook writer commits', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<void>) => { pending.push(work) } } })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-pull-request-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id only')
    const status = events.filter(event => event.kind === 'pull_request_status')
    if (status.length) sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: status })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `pr_live_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { createRequestDatabaseScope } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const home = randomUUID(), team = randomUUID(), personalTask = randomUUID(), teamTask = randomUUID(), unrelated = randomUUID()
  const label = (id: string) => ({ [home]: 'home', [team]: 'team', [personalTask]: 'personalTask', [teamTask]: 'teamTask', [unrelated]: 'unrelated' })[id] ?? id
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  const deliveries = async () => { await drain(); return sent.splice(0).map(value => `${value.scope.ownerId}@${label(value.scope.workspaceId)}:${value.events.map(event => `${event.kind}:${label(event.id)}`).join(',')}`).sort() }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@pr.example.invalid',true,now(),now())`, [userId])
      for (const workspaceId of [home, team]) { const value = { ownerId: userId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value) }
    }
    await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,'owner','Home','personal'),($2,'owner','Team','team')`, [home, team])
    for (const [workspace, userId] of [[home, 'owner'], [team, 'owner'], [team, 'peer']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [workspace, userId])
    }
    const agent = randomUUID()
    await database.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Coder','codex')`, [agent])
    // A personal task and a team task the PR was delivered on; a third task names the PR but has no delivery.
    await database.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope,"workspaceId") VALUES ($1,'owner','Personal',$4,'review','normal','personal',$5),($2,'owner','Team',$4,'review','normal','workspace',$6),($3,'owner','Unrelated',$4,'todo','normal','personal',$5)`, [personalTask, teamTask, unrelated, content, home, team])
    const grouping = await seedTeam(database, team, 'owner')
    await database.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,'owner')`, [teamTask, grouping.id, team])
    for (const issueId of [personalTask, teamTask]) {
      const run = randomUUID()
      await database.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt) VALUES ($1,'owner',$2,$3,'succeeded','Fix it')`, [run, issueId, agent])
      await database.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published',$3)`, [run, issueId, JSON.stringify({ url: pr, state: 'open' })])
    }
    const { refreshPublishedPullRequest } = await import('../github/publication-webhook')

    await t.test('a merged PR reaches the owner\'s home for the personal task and every team member for the team task', async () => {
      await scope.run(() => refreshPublishedPullRequest('pull_request', event(), database))
      assert.deepEqual(await deliveries(), ['owner@home:pull_request_status:personalTask', 'owner@team:pull_request_status:teamTask', 'peer@team:pull_request_status:teamTask'])
      const { rows } = await database.query(`SELECT "pullRequest"->>'state' AS state FROM run_publications`)
      assert.deepEqual(rows.map(row => row.state), ['merged', 'merged'])
    })

    await t.test('another event type or another PR sends nothing', async () => {
      await scope.run(() => refreshPublishedPullRequest('issues', event(), database))
      await scope.run(() => refreshPublishedPullRequest('pull_request', { ...event(), pull_request: { ...event().pull_request, number: 8, html_url: 'https://github.com/o/r/pull/8' } }, database))
      assert.deepEqual(await deliveries(), [])
    })

    await t.test('a write that fails sends nothing; a deleted task and a removed member are not told', async () => {
      await database.query(`CREATE FUNCTION reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication rejected'; END $$`)
      await database.query(`CREATE TRIGGER reject_publication BEFORE UPDATE ON run_publications FOR EACH ROW EXECUTE FUNCTION reject_publication()`)
      try {
        await assert.rejects(scope.run(() => refreshPublishedPullRequest('pull_request', event('open', false), database)), /publication rejected/)
        assert.deepEqual(await deliveries(), [], 'nothing committed: no key')
      } finally {
        await database.query('DROP TRIGGER reject_publication ON run_publications')
        await database.query('DROP FUNCTION reject_publication()')
      }
      await database.query(`UPDATE issues SET content=jsonb_set(content,'{attrs,mikka,deletedAt}','"2026-11-05T00:00:00Z"') WHERE id=$1`, [personalTask])
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='peer'`, [team])
      await scope.run(() => refreshPublishedPullRequest('pull_request', event('open', false), database))
      assert.deepEqual(await deliveries(), ['owner@team:pull_request_status:teamTask'])
      assert.deepEqual(unexpected, [])
    })
  } finally {
    await drain().catch(() => {})
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    globalDb.workspacePool = previousWorkspace
    await scope.close(); await database.end()
    await dropTestDatabase(admin, name); await admin.end()
    mock.restoreAll()
  }
})
