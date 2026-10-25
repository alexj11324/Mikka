import { randomBytes, randomUUID } from 'node:crypto'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { createCoordinatorSubmitter } from '../../lib/coordinator-submission'
import { createFactoryStore } from '../../lib/factory/store'
import { createFactoryDispatch } from '../../lib/factory/dispatch'
import { factoryDispatchDatabase } from '../../lib/factory/transaction'
import { insertRunOnce } from '../../lib/run-dispatch'
import { createFactoryQuestions, questionReference } from '../../lib/factory/questions/store'
import { app, browserClientHeaders, openCreateIssue } from './fixtures'

// Synthetic accounts only. Keep rows for inspection; never run against Preview/production.
test.beforeEach(() => {
  expect(process.env.CI).toBe('true')
  const url = new URL(process.env.E2E_DATABASE_URL!)
  expect(url.hostname).toBe('127.0.0.1')
  expect(url.pathname).toBe('/mikka_e2e')
  expect(process.env.COMPOSIO_API_KEY).toBeFalsy()
  expect(process.env.AI_GATEWAY_API_KEY).toBeFalsy()
})
async function signUp(client: APIRequestContext, origin: string) {
  const response = await client.post(app('/api/auth/sign-up/email'), { headers: { origin }, data: {
    email: `submission-${randomUUID()}@example.invalid`, name: 'Synthetic submission', password: randomBytes(32).toString('base64url'),
  } })
  expect(response.status()).toBe(200)
  return (await response.json()).user.id as string
}

test('frozen client against real HTTP/session/PG: concurrent retry, conflict, owner and Origin fences', async ({ playwright, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const a = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const b = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const anonymous = await playwright.request.newContext({ baseURL })
  const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  try {
    const ownerA = await signUp(a, origin), ownerB = await signUp(b, origin)
    let active = a, lost = false, ownerKnown = true, posts = 0
    const sent: { submissionId: string; text: string; questionId?: string }[] = []
    const client = createCoordinatorSubmitter({
      currentOwner: async () => {
        if (!ownerKnown) return null
        const response = await active.get(app('/api/auth/get-session?disableCookieCache=true'))
        return (await response.json())?.user?.id ?? null
      },
      fetch: async (_url, init) => {
        posts++; sent.push(JSON.parse(init.body as string))
        const response = await active.post(app('/api/coordinator/messages'), { headers: { origin }, data: init.body as string })
        const body = await response.text()
        if (lost) { lost = false; expect(response.status()).toBe(202); throw new Error('synthetic response loss AFTER server commit') }
        return new Response(body, { status: response.status() })
      },
    })
    ownerKnown = false
    expect((await client.submit('unresolved owner')).kind).toBe('authRequired'); expect(posts).toBe(0)
    ownerKnown = true; lost = true
    const text = `lost-${randomUUID()}`
    expect((await client.submit(text)).kind).toBe('uncertain')
    const first = sent[0].submissionId
    const retry = await Promise.all(Array.from({ length: 8 }, () => client.submit(text)))
    expect(retry.every(r => r.kind === 'accepted' && r.replayed)).toBe(true)
    expect(posts).toBe(2); expect(sent[1].submissionId).toBe(first)
    expect((await db.query('SELECT id FROM coordinator_events WHERE "dedupeKey"=$1', [`user_message:${ownerA}:${first}`])).rowCount).toBe(1)
    expect((await client.submit(text)).kind).toBe('accepted')
    expect(sent[2].submissionId).not.toBe(first) // Explicit send after accepted = new intent, same body.

    // Actual concurrent HTTP requests, beyond the client's in-flight coalescing.
    const concurrentId = randomUUID()
    const responses = await Promise.all(Array.from({ length: 8 }, () => a.post(app('/api/coordinator/messages'), { headers: { origin }, data: { text: 'parallel', submissionId: concurrentId } })))
    expect(responses.every(r => r.status() === 202)).toBe(true)
    const bodies = await Promise.all(responses.map(r => r.json()))
    expect(new Set(bodies.map(r => r.sourceEventId)).size).toBe(1)
    expect(bodies.filter(r => !r.replayed)).toHaveLength(1)
    let conflictPosts = 0
    const conflict = createCoordinatorSubmitter({ currentOwner: async () => ownerA, newId: () => concurrentId, fetch: async (_url, init) => {
      conflictPosts++
      const response = await a.post(app('/api/coordinator/messages'), { headers: { origin }, data: init.body as string })
      return new Response(await response.text(), { status: response.status() })
    } })
    expect((await conflict.submit('changed')).kind).toBe('conflict')
    expect((await conflict.submit('changed')).kind).toBe('conflict'); expect(conflictPosts).toBe(1)

    lost = true; const switched = `switch-${randomUUID()}`
    expect((await client.submit(switched)).kind).toBe('uncertain')
    const aId = sent.at(-1)!.submissionId
    active = b
    expect((await client.submit(switched)).kind).toBe('accepted')
    expect(sent.at(-1)!.submissionId).not.toBe(aId)
    expect((await db.query('SELECT id FROM coordinator_events WHERE "dedupeKey"=$1', [`user_message:${ownerB}:${aId}`])).rowCount).toBe(0)
    active = a
    const recovered = await client.submit(switched)
    expect(recovered.kind === 'accepted' && recovered.replayed).toBe(true)
    expect(sent.at(-1)!.submissionId).toBe(aId)

    const data = { text: 'session boundary', submissionId: randomUUID(), questionId: randomUUID() }
    expect((await anonymous.post(app('/api/coordinator/messages'), { headers: { origin }, data })).status()).toBe(401)
    expect((await a.post(app('/api/coordinator/messages'), { headers: { origin: 'https://untrusted.example.invalid' }, data })).status()).toBe(403)
    expect((await a.post(app('/api/coordinator/messages'), { data })).status()).toBe(403)
    const accepted = await a.post(app('/api/coordinator/messages'), { headers: { origin }, data })
    expect(accepted.status()).toBe(202)
    const event = (await db.query('SELECT payload FROM coordinator_events WHERE id=$1', [(await accepted.json()).sourceEventId])).rows[0]
    expect(event.payload.questionId).toBe(data.questionId)
    expect((await db.query('SELECT "userId" FROM session WHERE id=$1', [event.payload.humanSessionId])).rows[0].userId).toBe(ownerA)
    // The real browser-attested inbox event must resume exactly the waiting run.
    const deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), questionId = randomUUID()
    await db.query(`INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Synthetic question',true,now(),'[{"harness":"codex","installed":true}]')`, [deviceId, ownerA])
    await db.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'/isolated','fixture/repo')`, [repoId, deviceId, ownerA])
    await db.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,'Synthetic question','codex',$3)`, [agentId, ownerA, deviceId])
    await db.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Synthetic question','{}','todo','normal')`, [issueId, ownerA])
    const store = createFactoryStore(db, async (user, issue, tx) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1)
    const dispatch = createFactoryDispatch(db, store, (tx, user, input) => insertRunOnce(factoryDispatchDatabase(tx), user, input, { deviceId, baseBranch: 'main', prompt: 'Synthetic only' }))
    const questions = createFactoryQuestions(db, async (user, issue, tx) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1, store, dispatch)
    const sourceEventId = bodies[0].sourceEventId
    let state = await store.route(ownerA, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic submitted request' })
    await db.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"sessionId") VALUES ($1,$2,$3,$4,$5,$6,'running',$7)`, [runId, ownerA, issueId, agentId, deviceId, repoId, `synthetic:${runId}`])
    state = await store.apply(ownerA, { taskId: state.task.id, issueId, attemptId: state.task.attemptId, revision: state.task.revision, candidateId: state.task.candidateId }, randomUUID(), { action: 'bind_run', runId })
    await db.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',report=$2,"finishedAt"=now() WHERE id=$1`, [runId, JSON.stringify({ summary: 'Synthetic question', openQuestions: ['Continue?'], question: { questionId, kind: 'permission', question: 'Continue?', options: [] } })])
    const question = await questions.record(ownerA, runId)
    expect(question).toBeTruthy()
    lost = true
    const answerText = 'Continue within existing permissions'
    expect((await client.submit(answerText, questionId)).kind).toBe('uncertain')
    const answer = await client.submit(answerText, questionId)
    expect(answer.kind === 'accepted' && answer.replayed).toBe(true)
    if (answer.kind !== 'accepted' || !answer.sourceEventId || !question) throw new Error('Missing accepted question fixture')
    const request = { reference: questionReference(question), sourceEventId: answer.sourceEventId, answerId: randomUUID(), text: answerText }
    const continued = await questions.answer({ source: 'human_event', userId: ownerA }, request)
    expect((await questions.answer({ source: 'human_event', userId: ownerA }, request)).continuationRunId).toBe(continued.continuationRunId)
    expect((await db.query(`SELECT id FROM agent_runs WHERE "issueId"=$1 AND status='queued'`, [issueId])).rowCount).toBe(1)
    await db.query('UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE "userId"=$1', [ownerA])
    expect((await a.post(app('/api/coordinator/messages'), { headers: { origin }, data })).status()).toBe(401)
  } finally { await Promise.all([a.dispose(), b.dispose(), anonymous.dispose(), db.end()]) }
})

for (const entry of ['chat', 'task-dialog', 'command-panel'] as const) {
  test(`browser ${entry}: committed response loss retries the frozen submission once`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const owner = await signUp(page.request, new URL(baseURL!).origin)
    const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
    try {
      await page.goto(app('/'))
      const input = entry === 'task-dialog'
        ? (await openCreateIssue(page)).getByLabel('任务描述', { exact: true })
        : page.getByRole('textbox', { name: entry === 'chat' ? '给 Coordinator 发消息' : '给 Coordinator 发指令', exact: true })
      const text = `Synthetic ${entry} ${randomUUID()}`
      await input.fill(text)
      const requests: { submissionId: string; text: string }[] = []
      await page.route('**/api/coordinator/messages', async route => {
        if (route.request().method() !== 'POST') return route.continue()
        requests.push(route.request().postDataJSON())
        const response = await route.fetch()
        expect(response.status()).toBe(202)
        if (requests.length === 1) await route.abort('failed')
        else await route.fulfill({ response })
      })
      const send = async () => {
        if (entry === 'task-dialog') await page.getByRole('dialog').getByRole('button', { name: '创建任务', exact: true }).click()
        else await input.press('Enter')
      }
      await send()
      await expect.poll(() => requests.length).toBe(1)
      await expect(input).toBeEnabled()
      await send()
      await expect.poll(() => requests.length).toBe(2)
      if (entry === 'task-dialog') await expect(page.getByRole('dialog')).not.toBeVisible()
      else await expect(input).toHaveValue('')
      expect(requests[0]).toEqual(requests[1])
      expect(requests[0].submissionId).toMatch(/^[0-9a-f-]{36}$/)
      expect((await db.query('SELECT id FROM coordinator_events WHERE "dedupeKey"=$1', [`user_message:${owner}:${requests[0].submissionId}`])).rowCount).toBe(1)
    } finally { await db.end() }
  })
}
