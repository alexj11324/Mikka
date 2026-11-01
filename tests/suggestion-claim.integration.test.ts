import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { before, after as afterTests, mock, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { suggestions, coordinatorEvents } from '../lib/db/schema'

const url = new URL(process.env.E2E_DATABASE_URL ?? '')
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || url.hostname !== '127.0.0.1' || url.port !== '5432' || url.pathname !== '/mikka_e2e' || url.search || url.hash || process.env.MIKKA_DATABASE_URL !== url.href || process.env.DATABASE_URL !== url.href) throw new Error('requires GitHub Actions isolated mikka_e2e service')
const fixtureSchema = `suggestion_artifact_${randomUUID().replaceAll('-', '')}`
let scope: ReturnType<typeof import('../lib/db/request-scope').createRequestDatabaseScope>
const check = (name: string, run: () => Promise<void>) => test(name, () => scope.run(run))
let owner = 'owner'
const callbacks: Array<() => unknown> = []
let action: typeof import('../app/actions/coordinator').sendSuggestion
let db: typeof import('../lib/db').db
let pool: Pool
let artifactActions: typeof import('../app/actions/artifacts')
let claim: typeof import('../lib/suggestions/store').claimSuggestion
const id = 'b4000000-0000-4000-8000-000000000010'
const other = 'b4000000-0000-4000-8000-000000000011'
const concurrent = 'b4000000-0000-4000-8000-000000000012'
const retry = 'b4000000-0000-4000-8000-000000000013'
let release!: () => void
let signal!: () => void
before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => ({ user: { id: owner } }) } } } })
  mock.module('@/lib/coordinator/wake', { namedExports: { coordinatorEnabled: () => true, wakeCoordinator: () => { throw Error('must not invoke provider') } } })
  mock.module('next/server', { namedExports: { after: (fn: () => unknown) => callbacks.push(fn) } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  ;({ db, pool } = await import('../lib/db'))
  ;({ claimSuggestion: claim } = await import('../lib/suggestions/store'))
  ;({ sendSuggestion: action } = await import('../app/actions/coordinator'))
  artifactActions = await import('../app/actions/artifacts')
  await pool.query(`CREATE SCHEMA "${fixtureSchema}"`)
  const scopedUrl = new URL(url)
  scopedUrl.searchParams.set('options', `-c search_path=${fixtureSchema}`)
  scope = (await import('../lib/db/request-scope')).createRequestDatabaseScope(scopedUrl.href)
  console.info(`Retained CI fixture schema: ${fixtureSchema}`)
  await scope.run(() => pool.query(`CREATE TABLE suggestions (id uuid primary key,"botId" uuid, "userId" text not null, source text not null, "externalId" text not null, action text not null, title text not null, url text, actor text, shown boolean not null, "decidedBy" text not null, probability real, level text, "matterKey" text, "actionTitle" text, required boolean not null default false, "occurredAt" timestamptz not null, "dismissedAt" timestamptz, "createdAt" timestamptz not null default now()); CREATE TABLE coordinator_events (id uuid primary key, "userId" text not null, "botId" uuid, kind text not null, "dedupeKey" text not null unique, "issueId" uuid, "runId" uuid, payload jsonb not null CHECK (position('fail-fixture' in payload::text) = 0), tier text, "lastTriageAttemptAt" timestamptz, "triageDecision" jsonb, "deliveredAt" timestamptz, "createdAt" timestamptz not null default now())`))
  await scope.run(async () => pool.query(await readFile(new URL('../drizzle/20261031002604_coordinator_wake_recovery.sql', import.meta.url), 'utf8')))
  // The artifact list credits a run's versions to its Agent (R-78), so it reads the run tables too.
  await scope.run(() => pool.query(`CREATE TABLE agents (id uuid primary key, "userId" text not null, harness text not null, name text not null); CREATE TABLE agent_runs (id uuid primary key, "userId" text not null, "agentId" uuid not null, "botId" uuid); CREATE TABLE bots (id uuid primary key, "ownerId" text not null, name text not null); CREATE TABLE computer_run_bindings ("runId" uuid, "botId" uuid, "ownerId" text); CREATE TABLE bot_cloud_runtimes ("agentId" uuid, "botId" uuid, "ownerId" text); CREATE TABLE coordinator_bots ("ownerId" text, "workspaceId" uuid, "botId" uuid)`))
  await scope.run(() => pool.query(`CREATE TABLE artifacts (id uuid primary key, "userId" text not null, kind text not null, title varchar(200) not null, "runId" uuid, "issueId" uuid, "latestVersion" int not null default 1, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now()); CREATE TABLE artifact_versions (id uuid primary key, "artifactId" uuid not null, version int not null, "storageKey" text not null, "inlineContent" text, sha256 text not null, size int not null, "authorName" text not null, "createdAt" timestamptz not null default now(), unique("artifactId",version))`))
})
afterTests(async () => { await scope?.close(); await pool?.end() })
async function seed(key: string, title = 'synthetic') { await db.insert(suggestions).values({ id: key, userId: 'owner', source: 'gmail', externalId: key, action: 'reply', title, shown: true, decidedBy: 'rule', occurredAt: new Date() }) }
function gate() { const ready = new Promise<void>(r => { signal = r }); const proceed = new Promise<void>(r => { release = r }); return { ready, proceed } }

check('a concurrent dismiss wins before send: no event or wake', async () => {
  await seed(id)
  const g = gate()
  const first = db.transaction(async tx => { assert.ok(await claim('owner', id, tx)); signal(); await g.proceed })
  await g.ready
  let settled = false
  const second = action(id).then(result => { settled = true; return result })
  const deadline = Date.now() + 5000
  let blocked = false
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update %suggestions%'`)
    if (rows.length) { blocked = true; break }
    await new Promise(r => setTimeout(r, 10))
  }
  // Always release our own gate, including assertion failures; preserve rows and schema.
  try {
    assert.equal(blocked, true, 'second transaction reached the row lock')
    assert.equal(settled, false)
  } finally { release() }
  await first
  assert.deepEqual(await second, { error: 'suggestionNotFound', params: undefined })
  assert.equal((await db.select().from(coordinatorEvents)).length, 0); assert.equal(callbacks.length, 0)
})

check('failed insert rolls claim back; a successful send has an idempotent receipt', async () => {
  await seed(other, 'fail-fixture')
  await assert.rejects(action(other))
  assert.equal((await db.select().from(suggestions).where(eq(suggestions.id, other)))[0].dismissedAt, null)
  assert.equal(callbacks.length, 0)
  await seed(retry)
  owner = 'foreign'; assert.deepEqual(await action(retry), { error: 'suggestionNotFound', params: undefined }); owner = 'owner'
  assert.deepEqual(await action(retry), { queued: true })
  assert.deepEqual(await action(retry), { queued: true })
  assert.equal((await db.select().from(coordinatorEvents)).length, 1)
  assert.equal(callbacks.length, 2)
})

check('two concurrent sends commit one event and both receive a receipt', async () => {
  await seed(concurrent); callbacks.length = 0
  const results = await Promise.all([action(concurrent), action(concurrent)])
  assert.deepEqual(results, [{ queued: true }, { queued: true }])
  assert.equal((await db.select().from(coordinatorEvents)).length, 2)
  assert.equal(callbacks.length, 2)
})

check('Artifact actions return only owned rows, latest author, run filter and real timestamps', async () => {
  const runId = randomUUID(), mine = randomUUID(), foreign = randomUUID(), outside = randomUUID()
  await pool.query(`INSERT INTO artifacts (id,"userId",kind,title,"runId","latestVersion","updatedAt") VALUES ($1,'owner','markdown','Real fixture document',$2,2,'2026-10-28T10:00:00Z'),($3,'foreign','html','Private fixture',$2,1,'2026-10-28T11:00:00Z'),($4,'owner','html','Other run',null,1,'2026-10-28T09:00:00Z')`, [mine, runId, foreign, outside])
  for (const [artifactId, version, author] of [[mine,1,'Earlier author'],[mine,2,'Latest author'],[foreign,1,'Foreign author'],[outside,1,'Other author']] as const) {
    await pool.query(`INSERT INTO artifact_versions (id,"artifactId",version,"storageKey",sha256,size,"authorName") VALUES ($1,$2,$3,'synthetic','synthetic',1,$4)`, [randomUUID(),artifactId,version,author])
  }
  owner = 'owner'
  const listed = await artifactActions.listArtifacts()
  assert.deepEqual(listed.map(row => row.id), [mine, outside])
  assert.equal(listed[0].authorName, 'Latest author')
  assert.equal(listed[0].latestVersion, 2)
  assert.equal(listed[0].updatedAt, '2026-10-28T10:00:00.000Z')
  assert.equal(listed[0].issueKey, null)
  assert.deepEqual((await artifactActions.listRunArtifacts(runId)).map(row => row.id), [mine])
  assert.deepEqual(await artifactActions.listRunArtifacts('invalid'), [])
  owner = 'foreign'
  assert.deepEqual((await artifactActions.listRunArtifacts(runId)).map(row => row.id), [foreign])
  owner = 'owner'
})
