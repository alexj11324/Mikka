import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { refreshPublishedPullRequest } from './publication-webhook'
import { dropTestDatabase } from '../../tests/support/drop-test-database'

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

test('a PR webhook records its line counts on the delivery and on the tasks it belongs to, as a versioned system change', { skip: !base, timeout: 120_000 }, async () => {
  const admin = guarded(base!)
  const name = `prw_${randomUUID().replaceAll('-', '')}_e2e`
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 })
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`)
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString())
  const pool = new Pool({ connectionString: target.toString(), max: 2 })
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
  } finally {
    // Only after every client of this test's own database has closed (#913).
    await dropTestDatabase(adminPool, name, pool)
    await adminPool.end()
  }
})
