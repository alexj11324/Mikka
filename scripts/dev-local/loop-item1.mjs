// WIP (handoff): local-loop item 1 (core loop) via HTTP API + DB only. Logs one line per step to the progress log. No secret printed.
import { appendFileSync, readFileSync } from 'node:fs'
import pg from 'pg'
const BASE = 'http://localhost:3110/mikka', ORIGIN = 'http://localhost:3110', FAKE = 'http://127.0.0.1:3191'
const LOG = process.env.LOCAL_LOOP_LOG ?? '.cache/dev-local/progress.log'
const t0 = Date.now()
const line = (step, status, detail = '') => { const s = `${new Date().toISOString().slice(11, 19)} ITEM1 ${step} ${status} +${Math.round((Date.now() - t0) / 1000)}s ${detail}`.trim(); console.log(s); appendFileSync(LOG, s + '\n') }
const pool = new pg.Pool({ connectionString: process.env.MIKKA_DATABASE_URL, max: 1 })
const q = async (sql, args = []) => (await pool.query(sql, args)).rows
const until = async (step, ms, fn) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { line(step, 'fail', `timeout ${ms / 1000}s`); throw new Error(step) } await new Promise(r => setTimeout(r, 2000)) } }
try {
  const email = 'fork-n-local@example.test', password = process.env.LOCAL_LOOP_PASSWORD ?? ''
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email, password }) })
  const cookie = signIn.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  line('sign-in', signIn.ok ? 'ok' : 'fail', `HTTP ${signIn.status}`)
  if (!signIn.ok) throw new Error('sign-in')
  const [{ id: userId }] = await q('SELECT id FROM "user" WHERE email = $1', [email])
  const since = new Date()
  const text = `新任务：在 GitHub 仓库 mikka-e2e/core-loop 里，README.md 末尾加一行 api loop ${since.toISOString().slice(11, 19)}，然后提交并开 PR。`
  const sent = await fetch(`${BASE}/api/coordinator/messages`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie }, body: JSON.stringify({ text }) })
  line('dispatch', sent.status === 202 ? 'ok' : 'fail', `POST /api/coordinator/messages → HTTP ${sent.status} ${JSON.stringify(await sent.json())}`)
  const run = await until('run-created', 120_000, async () => (await q('SELECT id FROM agent_runs WHERE "userId"=$1 AND "createdAt">$2 ORDER BY "createdAt" DESC LIMIT 1', [userId, since]))[0])
  line('run-created', 'ok', run.id)
  let last = ''
  const ended = await until('run-end', 420_000, async () => {
    const [r] = await q('SELECT r.status, r.error, p.status AS pub, p."pullRequest" AS pr FROM agent_runs r LEFT JOIN run_publications p ON p."runId"=r.id WHERE r.id=$1', [run.id])
    const now = `${r.status} pub=${r.pub ?? '-'}`
    if (now !== last) { line('run-status', 'ok', now); last = now }
    return (r.pr || ['failed', 'cancelled', 'stopped'].includes(r.status)) ? r : null
  })
  if (!ended.pr) { line('run-end', 'fail', `${ended.status}: ${(ended.error ?? '').slice(0, 300)}`); throw new Error('run failed') }
  line('pr-opened', 'ok', JSON.stringify(ended.pr).slice(0, 200))
  const obs = await (await fetch(`${FAKE}/observations`)).json()
  line('fake-github', obs.pullRequests.length ? 'ok' : 'fail', JSON.stringify(obs.pullRequests))
  const url = ended.pr.url ?? obs.pullRequests.at(-1)?.url
  await until('thread-shows-pr', 120_000, async () => {
    const view = await (await fetch(`${BASE}/api/coordinator/messages`, { headers: { cookie } })).text()
    return url && view.includes(url)
  })
  line('thread-shows-pr', 'ok', `GET /api/coordinator/messages contains ${url}`)
  line('done', 'ok')
} catch (error) { line('error', 'fail', error.message); process.exitCode = 1 } finally { await pool.end() }
