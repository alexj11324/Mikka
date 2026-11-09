// #1212: how many database statements one verified GitHub delivery runs, on a
// real PostgreSQL, per common event. GitHub sends Mikka every pull_request,
// issue_comment and push on the repositories the App is installed on, so these
// budgets are a hard ceiling; raise one only with the reason in the PR.
// The Decisions API is replaced by a judge that gives no answer: what a
// notification costs after a model answers is the model path's own budget.
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import pg from 'pg'
import { isE2eTarget } from './helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from './helpers/task-workspace'

const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('GitHub webhook statement tests require matching isolated loopback _e2e URLs')

const secret = 'statement-count-webhook-secret'
const originalEdition = process.env.MIKKA_EDITION
after(() => { if (originalEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = originalEdition })
const callbacks: Array<() => unknown> = []
mock.module('next/server', { namedExports: { after: (callback: () => unknown) => { callbacks.push(callback) } } })
mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: {
  decide: async () => null, invokeDecision: async () => null, callDecisionRequest: async () => { throw new Error('no model in this test') },
} })

// Every statement goes through Client.query (pool.query and drizzle alike); `bytes` adds up the JSON of the rows it returned.
let counting = false
const statements: string[] = []
const received = { bytes: 0 }
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
  if (counting) {
    const text = args[0]
    statements.push(String(typeof text === 'string' ? text : (text as { text?: string })?.text ?? '').replace(/\s+/g, ' '))
    const add = (value: unknown) => { received.bytes += JSON.stringify((value as { rows?: unknown[] })?.rows ?? []).length }
    const last = args.length - 1
    // pool.query hands Client.query a callback; drizzle and direct client calls take the promise.
    if (typeof args[last] === 'function') {
      const callback = args[last] as (error: unknown, value: unknown) => void
      args[last] = (error: unknown, value: unknown) => { if (!error) add(value); callback(error, value) }
    } else {
      const result = (query as (...a: unknown[]) => unknown).apply(this, args)
      if (result instanceof Promise) void result.then(add, () => {})
      return result
    }
  }
  return (query as (...a: unknown[]) => unknown).apply(this, args)
} as typeof query

let POST: typeof import('../app/api/webhooks/github/route')['POST']
let pool: pg.Pool
before(async () => {
  if (!valid) return
  // This suite measures the official App's existing webhook path. Community
  // installations load their own encrypted App in the manifest DB suite.
  process.env.MIKKA_EDITION = 'cloud'
  process.env.GITHUB_WEBHOOK_SECRET = secret
  ;({ POST } = await import('../app/api/webhooks/github/route'))
  ;({ pool } = await import('../lib/db'))
  // OAuth and Factory GitHub resource registration share auth startup.
  // Finish that same instance before measuring per-delivery statements.
  await (await import('../lib/auth')).auth.$context
})

/** Runs one signed delivery and its background work; returns the statements it sent. */
async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload)
  statements.length = 0
  received.bytes = 0
  callbacks.length = 0
  counting = true
  try {
    const response = await POST(new Request('https://preview.example.test/mikka/api/webhooks/github', {
      method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
    }))
    assert.ok([202, 204].includes(response.status), `${event}: ${response.status}`)
    for (const callback of callbacks) await callback()
  } finally { counting = false }
  return [...statements]
}

const pullRequest = (url: string, number: number, action: string, extra: Record<string, unknown> = {}) => ({
  action, number, repository: { full_name: 'o/r' }, sender: { id: 1, login: 'someone', type: 'User' },
  pull_request: { number, html_url: url, title: 'Fix the login page', state: 'open', draft: false, merged_at: null, additions: 10, deletions: 2,
    user: { id: 1 }, head: { sha: 'a'.repeat(40) }, merge_commit_sha: null, updated_at: '2026-11-05T00:00:00Z', ...extra },
})

test('one GitHub delivery stays within its statement budget', { skip: !valid, timeout: 120_000 }, async t => {
  const owner = `gh-stmt-${randomUUID()}`, githubId = String(100_000 + Math.floor(Math.random() * 1_000_000))
  const issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), number = 1000 + Math.floor(Math.random() * 100_000)
  const delivered = `https://github.com/o/r/pull/${number}`, unrelated = `https://github.com/o/r/pull/${number + 1}`
  await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'O',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
  const workspaceId = await seedFixtureWorkspace(pool, owner)
  await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubId, owner])
  await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,'Coder','codex')`, [agentId, owner])
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority,"workspaceId") VALUES ($1,$2,'Delivered',$3,'review','normal',$4)`,
    [issueId, owner, JSON.stringify({ type: 'doc', attrs: { mikka: { pullRequests: [{ url: delivered, state: 'open' }] } }, content: [] }), workspaceId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt) VALUES ($1,$2,$3,$4,'succeeded','Fix it')`, [runId, owner, issueId, agentId])
  await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,$2,$3,'https://github.com/o/r','o/r','published',$4)`,
    [runId, owner, issueId, JSON.stringify({ url: delivered, state: 'open' })])
  t.after(async () => {
    for (const table of ['attention_matters', 'suggestions']) await pool.query(`DELETE FROM ${table} WHERE "userId"=$1`, [owner])
    await pool.query('DELETE FROM run_publications WHERE "runId"=$1', [runId])
    await pool.query('DELETE FROM issue_versions WHERE "issueId"=$1', [issueId])
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId])
    await pool.query('DELETE FROM issues WHERE id=$1', [issueId])
    await pool.query('DELETE FROM agents WHERE id=$1', [agentId])
    await pool.query('DELETE FROM account WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    await pool.end()
  })
  const budget = async (label: string, event: string, payload: unknown, most: number) => {
    const sent = await deliver(event, payload)
    t.diagnostic(`${label}: ${sent.length} statements`)
    assert.ok(sent.length <= most, `${label}: ${sent.length} statements, budget ${most}\n${sent.join('\n')}`)
    return sent
  }

  await budget('push', 'push', { ref: 'refs/heads/main', repository: { full_name: 'o/r' } }, 0)
  await budget('pull_request labeled', 'pull_request', pullRequest(delivered, number, 'labeled'), 0)
  await budget('pull_request opened, a PR Mikka never delivered', 'pull_request', pullRequest(unrelated, number + 1, 'opened'), 1)
  await budget('pull_request synchronize, new line counts', 'pull_request', pullRequest(delivered, number, 'synchronize'), 2)
  await budget('pull_request synchronize, nothing stored changed', 'pull_request', pullRequest(delivered, number, 'synchronize'), 2)
  const merged = await budget('pull_request closed+merged', 'pull_request',
    pullRequest(delivered, number, 'closed', { state: 'closed', merged: true, merged_at: '2026-11-05T01:00:00Z', merge_commit_sha: 'b'.repeat(40) }), 3)
  assert.ok(merged.some(text => text.includes('factory_tasks')), 'the merge still looks for Factory tasks waiting on the PR')
  const { rows: [publication] } = await pool.query('SELECT "pullRequest" FROM run_publications WHERE "runId"=$1', [runId])
  assert.equal(publication.pullRequest.state, 'merged', 'the delivery shows the merge')
  await budget('issue_comment on an issue by someone without Mikka', 'issue_comment',
    { action: 'created', repository: { full_name: 'o/r' }, sender: { id: 2, login: 'other' }, issue: { number, user: { id: 999_999_999 }, title: 'Bug' }, comment: { id: 1, body: 'hi', created_at: '2026-11-05T00:00:00Z' } }, 1)
  // The person's recent matters, each with the evidence a few notices leave (~10 KB).
  const notices = Array.from({ length: 6 }, (_, n) => ({ title: `Notice ${n}`, excerpt: 'x'.repeat(1_500), occurredAt: '2026-11-04T00:00:00Z' }))
  for (let n = 0; n < 10; n++) await pool.query(`INSERT INTO attention_matters (id,"userId","matterKey",source,title,level,assessment,evidence,state)
    VALUES ($1,$2,$3,'github',$4,'normal',$5,$6,'quiet')`, [randomUUID(), owner, `github:o/r#${n}`, `Matter ${n}`, JSON.stringify({ cost: true, note: 'y'.repeat(500) }), JSON.stringify({ keys: [`github:o/r#${n}`], latest: notices[0], notices })])
  const comment = await budget('issue_comment on the person\'s issue (judge gives no answer)', 'issue_comment',
    { action: 'created', repository: { full_name: 'o/r' }, sender: { id: 2, login: 'other' }, issue: { number, user: { id: Number(githubId) }, title: 'Bug' }, comment: { id: Number(githubId), body: 'hi', created_at: '2026-11-05T00:00:00Z' } }, 8)
  // A full matter row (its evidence and assessment, tens of KB) is what made this route heavy; the judgment reads only its brief.
  assert.ok(comment.some(text => text.includes('"attention_matters"')), 'the judgment still reads the person\'s matters')
  assert.ok(comment.every(text => !text.includes('"assessment"')), 'no matter evidence or assessment is read')
  t.diagnostic(`issue_comment on the person's issue: ${received.bytes} bytes of rows`)
  assert.ok(received.bytes < 5_000, `${received.bytes} bytes of rows`)
})
