import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import type { Page, Route, TestInfo } from '@playwright/test'
import { app, openCreateIssue } from '../e2e/fixtures'
import { test, expect, GITHUB_FAVICON } from './accounts'
import type { AccountScope } from '../../scripts/test-accounts/session.mjs'
import { recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'
import { assertMvpEnvironment, MVP_SERVICES, REPOSITORY, REPOSITORY_KEY } from './isolated-env.mjs'
import { RepositoryCache } from '../../packages/daemon/src/repositories'
import { finishMvpResources, indexMvpResource } from './retention.mjs'
import { seedMvpSubscription, seedMvpExecutionRule } from './subscription.mjs'
import { HostedUsageStore } from '../../lib/abuse/store'

const execute = promisify(execFile)
type Device = { id: string; name: string; protocolVersion: number }
type Run = { id: string; issueId: string; deviceId: string; deviceRepoId: string; baseBranch: string | null; status: string; stopReason: string | null; error: string | null; report: { summary: string; verify: { status: string }; publish?: { pushed: boolean; commit: string; branch: string } } | null; worktreePath: string | null; stopRequestedAt: string | null }
type Observation = { kind: string; toolName?: string; deviceId?: string; runId?: string; issueId?: string; url?: string; commit?: string; branch?: string; requestId?: string; path?: string }
type ServiceEvidence = { observations: Observation[]; errors: unknown[]; pullRequests: { number: number; url: string; branch: string; draft: boolean }[] }
type MvpCheckpoint = 'accounts-active' | 'home-open' | 'fixture-ready' | 'daemon-started' | 'daemon-registered' | 'task-submitted' | 'event-bound' | 'run-dispatched' | 'worktree-ready' | 'reply-delivered' | 'published' | 'favicon-decoded' | 'chat-result-verified' | 'stop-completed'

assertMvpEnvironment()
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
test.afterAll(async () => { await pool.end() })

async function service<T>(path: string, input?: object): Promise<T> {
  const response = await fetch(`${MVP_SERVICES}${path}`, input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : undefined)
  expect(response.ok, `fixture ${path} must succeed`).toBe(true)
  return response.json() as Promise<T>
}

async function setup(page: Page, testInfo: TestInfo, accounts: AccountScope) {
  const checkpoints: { at: string; code: MvpCheckpoint; step: string }[] = []
  const checkpoint = (code: MvpCheckpoint, step: string) => {
    checkpoints.push({ at: new Date().toISOString(), code, step })
    // Only fixed phase codes enter the runner log. Detailed identifiers stay
    // in the existing evidence attachment, and the log is audited before cat.
    console.info(`MVP checkpoint: ${code}`)
  }
  const startedAt = new Date().toISOString()
  const marker = `mvp-${randomUUID()}`
  const title = `MVP ${marker.slice(4, 12)}`
  // Personal task prefixes share the repository's branch namespace. Keep the
  // two disposable owners distinct so the real branch-collision guard stays on.
  const prefix = testInfo.title.startsWith('Stopping') ? 'STPM' : 'LOOP'
  await accounts.assertActive()
  checkpoint('accounts-active', 'Automatic account lease is active')
  const user = { id: accounts.owner.userId }
  await pool.query('INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,$2) ON CONFLICT ("userId") DO UPDATE SET prefix=EXCLUDED.prefix', [user.id, prefix])
  await page.goto(app('/'))
  checkpoint('home-open', 'Authenticated home loaded')
  const subscription=await seedMvpSubscription(pool,user.id)
  // The subscription model remains BYO. Its scripted hosted event-classifier
  // has a separate, explicitly verified fixture allowance; no gate is bypassed.
  await new HostedUsageStore(pool).verify(subscription.workspaceId,`cus_mvp_${user.id}`,`card_mvp_${user.id}`)
  await indexMvpResource('owner-id', user.id)
  await indexMvpResource('scenario-id', marker)
  const githubAccountId = String(randomInt(1_000_000, 2_000_000_000))
  const scenario = await service<{ barePath: string; repo: string; baseBranch: string }>('/scenario', { marker, title, githubAccountId })
  checkpoint('fixture-ready', 'Isolated repository and synthetic services are ready')
  const token = `orv_${randomBytes(32).toString('base64url')}`
  await recordAuthenticationSecrets([token])
  const tokenId = randomUUID()
  const dataDir = await mkdtemp(join(tmpdir(), 'mikka-mvp-daemon-'))
  await indexMvpResource('daemon-directory', dataDir)
  await indexMvpResource('token-id', tokenId)
  await pool.query('INSERT INTO device_tokens (id, "userId", name, "tokenHash") VALUES ($1, $2, $3, $4)', [tokenId, user.id, 'Disposable MVP daemon', createHash('sha256').update(token).digest('hex')])
  // The GitHub identity is synthetic. Push is what the (synthetic) GitHub App
  // grants on the repository: contents: write and this account's own write
  // access, checked live at dispatch. Mikka shows no approval card for it.
  await pool.query('INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, now(), now())', [randomUUID(), githubAccountId, 'github', user.id])
  await pool.query('INSERT INTO repository_settings ("userId", "remoteKey", "verifyCommand") VALUES ($1, $2, $3)', [user.id, REPOSITORY_KEY, 'test -f MIKKA_MOCK.md'])
  const daemon = spawn(process.execPath, ['--import', 'tsx', 'tests/mvp/start-daemon.mts'], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MIKKA_E2E_DEVICE_TOKEN: token, MIKKA_E2E_DAEMON_DIR: dataDir,
      // Only this child sees the transport rewrite. No global git config or
      // user checkout is touched. Repository identity remains GitHub-shaped
      // so the production PR validation is exercised against a file:// origin.
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(scenario.barePath).href}.insteadOf`, GIT_CONFIG_VALUE_0: REPOSITORY,
      GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always', GIT_TERMINAL_PROMPT: '0' },
  })
  checkpoint('daemon-started', 'Spawned the real CLI daemon process')
  let daemonOutput = ''
  const capture = (chunk: Buffer) => { daemonOutput = (daemonOutput + chunk.toString()).replaceAll(token, '[redacted]').slice(-20_000) }
  daemon.stdout?.on('data', capture); daemon.stderr?.on('data', capture)
  const browserRequests: { id: string; path: string; status: number }[] = []
  page.on('response', response => {
    const headers = response.headers()
    const id = headers['x-vercel-id'] ?? headers['x-request-id']
    if (id) browserRequests.push({ id, path: new URL(response.url()).pathname, status: response.status() })
  })
  let device: Device | undefined
  let runId: string | undefined
  let assertionsCompleted = false
  const cleanup = async () => {
    await finishMvpResources({
      revoke: async () => { await pool.query('UPDATE device_tokens SET "revokedAt" = now() WHERE id = $1 AND "userId" = $2', [tokenId, user.id]) },
    })
    const services = await service<ServiceEvidence>('/observations').catch(() => ({ observations: [], errors: ['Fixture service unavailable'], pullRequests: [] }))
    const sha = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim()
    const runs = (await pool.query('SELECT id, "issueId", "deviceId", status, "stopReason", error, CASE WHEN status IN (\'failed\', \'cancelled\') THEN report->>\'summary\' END AS "failureSummary" FROM agent_runs WHERE "userId" = $1', [user.id])).rows.map(row => ({ ...row, error: row.error?.replaceAll(token, '[redacted]').slice(0, 2000) ?? null, failureSummary: row.failureSummary?.replaceAll(token, '[redacted]').slice(0, 2000) ?? null }))
    const publications = (await pool.query('SELECT "runId", status, "workflowRunId", "errorCode", "pullRequest" FROM run_publications WHERE "userId" = $1', [user.id])).rows
    const evidence = { subscription, sha, githubSha: process.env.GITHUB_SHA ?? null, environment: 'disposable GitHub Actions Postgres / Next production build', authentication: { mode: 'automatic-account-pool', environmentId: accounts.lease.environmentId, leaseId: accounts.lease.id, generation: accounts.lease.generation, ownerId: user.id, oauthProviderVerified: false }, startedAt, finishedAt: new Date().toISOString(), scenarioAssertions: assertionsCompleted ? 'completed' : 'incomplete or failed', overallResult: 'See the Playwright report; runtime guard and teardown run after this attachment', marker, deviceId: device?.id ?? null, runId: runId ?? null, checkpoints, runs, publications, requestIds: { browser: browserRequests, fixture: services.observations.flatMap(row => row.requestId ? [row.requestId] : []) }, services,
      boundaries: ['Scripted subscription worker/model boundary; real binding/workspace authorization, Mikka WorkflowAgent and durable tools', 'GitHub API stub; real daemon clone/worktree/verify/commit/push', 'Synthetic GitHub repository identity; daemon-only file:// transport rewrite', 'Synthetic proposal through real store and authenticated browser decision; GitHub identity is seeded', 'No production or Preview acceptance performed by this suite'] }
    console.info(JSON.stringify({ mvpScenario: prefix === 'STPM' ? 'stop' : 'publish', assertionsCompleted, checkpoints: checkpoints.map(row => row.code), runCount: runs.length, publicationCount: publications.length, syntheticPullRequests: services.pullRequests.length, syntheticErrors: services.errors.length }))
    await testInfo.attach('mvp-acceptance-evidence.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
    if (daemonOutput) await testInfo.attach('daemon-output', { body: daemonOutput, contentType: 'text/plain' })
    // Credentials, daemon.secret, device.json and Workflow storage are never artifacts.
  }
  try {
    await expect.poll(async () => {
      if (daemon.exitCode !== null) throw new Error(`Daemon exited with code ${daemon.exitCode}`)
      const { rows } = await pool.query<Device>('SELECT id, name, "protocolVersion" FROM devices WHERE "ownerId" = $1 AND kind = $2', [user.id, 'local'])
      device = rows[0]
      return rows.length
    }, { timeout: 45_000 }).toBe(1)
    expect(device!.protocolVersion).toBeGreaterThanOrEqual(3)
    await indexMvpResource('device-id', device!.id)
    await expect.poll(async () => (await pool.query('SELECT id FROM agents WHERE "userId" = $1 AND "deviceId" = $2 AND harness = $3', [user.id, device!.id, 'mock'])).rowCount).toBe(1)
    await seedMvpExecutionRule(pool,user.id,subscription.workspaceId,device!.id)
    await service('/scenario/device', { deviceId: device!.id })
    checkpoint('daemon-registered', 'Real daemon logged in, registered and exposed its mock harness')
    const dialog = await openCreateIssue(page)
    const machine = dialog.getByRole('combobox', { name: '运行的机器', exact: true })
    await expect(machine).toContainText('Mikka Cloud')
    await machine.click()
    await page.getByRole('option').filter({ hasText: device!.name }).click()
    await expect(machine).toContainText(device!.name)
    await dialog.getByLabel('任务描述', { exact: true }).fill(`创建任务「${title}」，在这台电脑修改 ${REPOSITORY}，添加 MIKKA_MOCK.md，完成后开 PR。${marker}`)
    await testInfo.attach('01-local-device-selected', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })
    await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    checkpoint('task-submitted', 'Browser submitted the task with the selected local device')
    await expect.poll(async () => {
      const { rows } = await pool.query<{ payload: { taskDestination?: unknown } }>('SELECT payload FROM coordinator_events WHERE "userId" = $1 AND kind = $2 AND payload->>\'text\' LIKE $3', [user.id, 'user_message', `%${marker}%`])
      return rows[0]?.payload.taskDestination
    }).toEqual({ kind: 'device', deviceId: device!.id })
    await expect.poll(async () => {
      const { rows } = await pool.query<Run>('SELECT r.* FROM agent_runs r INNER JOIN issues i ON i.id = r."issueId" WHERE r."userId" = $1 AND i.title = $2', [user.id, title])
      runId = rows[0]?.id
      return rows.length
    }, { timeout: 60_000 }).toBe(1)
    await indexMvpResource('run-id', runId!)
    const run = async () => (await pool.query<Run>('SELECT * FROM agent_runs WHERE id = $1 AND "userId" = $2', [runId, user.id])).rows[0]
    expect((await run()).deviceId).toBe(device!.id)
    expect((await run()).baseBranch).toBeNull()
    expect((await pool.query('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])).rowCount).toBe(1)
    const event = await pool.query<{ id: string; issueId: string; deliveredAt: Date | null; botId: string | null; payload: { taskDestination?: unknown } }>(
      'SELECT id, "issueId", "deliveredAt", "botId", payload FROM coordinator_events WHERE "userId" = $1 AND kind = $2 AND payload->>\'text\' LIKE $3', [user.id, 'user_message', `%${marker}%`])
    expect(event.rows).toHaveLength(1)
    expect(event.rows[0]).toMatchObject({ issueId: (await run()).issueId, botId: null, payload: { taskDestination: { kind: 'device', deviceId: device!.id } } })
    expect(event.rows[0].deliveredAt).toBeTruthy()
    const receipt = await pool.query('SELECT operation, "issueId" FROM issue_tool_calls WHERE "userId" = $1 AND "toolCallId" = $2', [user.id, `${marker}-dispatch-create_issue`])
    expect(receipt.rows).toEqual([{ operation: 'create_issue', issueId: event.rows[0].issueId }])
    checkpoint('event-bound', `Delivered task event ${event.rows[0].id} bound to the same issue as the create tool receipt and run`)
    const repo = (await pool.query<{ repoPath: string; remoteUrl: string; baseBranch: string | null }>('SELECT "repoPath", "remoteUrl", "baseBranch" FROM device_repos WHERE id = $1', [(await run()).deviceRepoId])).rows[0]
    expect(repo).toEqual({ repoPath: REPOSITORY_KEY, remoteUrl: REPOSITORY, baseBranch: null })
    checkpoint('run-dispatched', 'Coordinator created exactly one task and dispatched to the selected device')
    const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
    const threadTitle = title
    const card = chat.getByRole('button', { name: `打开线程 ${threadTitle}`, exact: true })
    await expect(card).toBeVisible()
    await card.click()
    const thread = page.getByRole('region', { name: threadTitle, exact: true })
    const beforeProgress = await run()
    if (['failed', 'cancelled'].includes(beforeProgress.status)) {
      throw new Error(`MVP daemon ${beforeProgress.status}: ${(beforeProgress.error ?? beforeProgress.report?.summary ?? beforeProgress.stopReason ?? 'No error recorded').replaceAll(token, '[redacted]').slice(0, 2000)}`)
    }
    try {
      await expect(thread.getByRole('list', { name: '线程对话' })).toContainText('正在检查仓库', { timeout: 60_000 })
    } catch (error) {
      // The daemon runs in foreground release mode: stdout is not its log.
      // Retain the server-masked failure instead of an empty-thread timeout alone.
      const current = await run()
      const failure = current?.error ?? (['failed', 'cancelled'].includes(current?.status) ? current.report?.summary : null)
      if (failure) throw new Error(`MVP daemon ${current.status}: ${failure.replaceAll(token, '[redacted]').slice(0, 2000)}`, { cause: error })
      throw error
    }
    expect((await run()).status).toBe('running')
    const cachePath = new RepositoryCache(join(dataDir, 'repos')).pathFor(REPOSITORY)
    const worktreePath = (await run()).worktreePath
    expect(worktreePath).toBe(join(dataDir, 'worktrees', runId!))
    expect((await readFile(join(worktreePath!, '.git'), 'utf8')).trim()).toContain(`${cachePath}/.git/worktrees/`)
    expect((await execute('git', ['-C', cachePath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim()).toBe('origin/trunk')
    checkpoint('worktree-ready', 'Daemon claimed assignment, cloned into its cache and resolved origin/trunk')
    return { title, threadTitle, userId: user.id, dataDir, device: device!, runId: runId!, run, chat, card, thread, cleanup, checkpoint, completeAssertions: () => { assertionsCompleted = true } }
  } catch (error) { await cleanup(); throw error }
}

test('Chat creates a task, the selected real daemon runs it, and the pushed PR returns to chat', { tag: '@smoke' }, async ({ page, testAccounts }, testInfo) => {
  const loop = await setup(page, testInfo, testAccounts.scope)
  try {
    const reply = '请保留 README 的现有内容。'
    const composer = loop.thread.getByRole('textbox', { name: '告诉 mock 下一步做什么…', exact: true })
    await composer.fill(reply)
    await composer.press('Enter')
    await expect(loop.thread.getByRole('list', { name: '线程对话' })).toContainText(`Noted: ${reply}`)
    await expect.poll(async () => (await pool.query('SELECT "deliveredAt" FROM run_messages WHERE "runId" = $1 AND text = $2', [loop.runId, reply])).rows[0]?.deliveredAt != null).toBe(true)
    loop.checkpoint('reply-delivered', 'Thread reply reached the real daemon and was acknowledged')
    await testInfo.attach('02-thread-progress-and-reply', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })
    await expect.poll(async () => (await loop.run()).status, { timeout: 75_000 }).toBe('succeeded')
    const completed = await loop.run()
    expect(completed.stopReason).toBe('submitted')
    expect(completed.report?.verify.status).toBe('passed')
    expect(completed.report?.publish?.pushed).toBe(true)
    await expect.poll(async () => (await pool.query('SELECT status FROM run_publications WHERE "runId" = $1', [loop.runId])).rows[0]?.status, { timeout: 60_000 }).toBe('published')
    const pr = 'https://github.com/mikka-e2e/core-loop/pull/41'
    const task = (await pool.query('SELECT status, content FROM issues WHERE id = $1', [completed.issueId])).rows[0]
    expect(task.status).toBe('review')
    expect(task.content.attrs.mikka.pullRequests).toContainEqual({ url: pr, state: 'open' })
    const evidence = await service<ServiceEvidence>('/observations')
    expect(evidence.errors).toEqual([])
    expect(evidence.pullRequests).toEqual([{ number: 41, url: pr, branch: completed.report!.publish!.branch, draft: false }])
    expect(evidence.observations.filter(item => item.kind === 'pull-request-created')).toEqual([expect.objectContaining({ runId: loop.runId, issueId: completed.issueId, commit: completed.report!.publish!.commit })])
    expect(evidence.observations.filter(item => item.kind === 'tool').map(item => item.toolName)).toEqual(expect.arrayContaining(['create_issue', 'list_agents', 'dispatch_run']))
    expect(Number((await pool.query('SELECT count(*) FROM pending_actions WHERE "userId" = $1 AND action = $2', [loop.userId, 'approve_repository_push'])).rows[0].count), 'the GitHub App grant pushes without a card in Mikka').toBe(0)
    expect((await pool.query('SELECT "pushGrantedAt" FROM github_repository_installations WHERE "userId" = $1 AND "remoteKey" = $2', [loop.userId, REPOSITORY_KEY])).rows[0]?.pushGrantedAt).toBeTruthy()
    expect(evidence.observations.filter(item => item.kind === 'github-request' && item.path === '/repos/mikka-e2e/core-loop/installation').length, 'dispatch checked the App installation on GitHub').toBeGreaterThan(0)
    loop.checkpoint('published', 'Real verification and push completed; GitHub stub confirmed the commit and stored PR on the task')
    await loop.thread.getByRole('button', { name: '返回 Coordinator', exact: true }).click()
    await expect(loop.chat).toContainText('已完成：Added MIKKA_MOCK.md', { timeout: 60_000 })
    await expect(loop.chat.locator(`[data-agent-markdown] a[href="${pr}"]`)).toBeVisible()
    const favicon = loop.chat.locator(`img[src="${GITHUB_FAVICON}"]`).first()
    await expect(favicon).toBeVisible()
    await expect.poll(() => favicon.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
    loop.checkpoint('favicon-decoded', 'The real PR citation image decoded the synthetic favicon response')
    const prCard = loop.chat.locator('[data-slot="thread-card"]').filter({ has: page.getByRole('button', { name: `打开线程 ${loop.threadTitle}`, exact: true }) })
    const prChip = prCard.getByRole('link', { name: 'PR #41', exact: true })
    await expect(prChip).toHaveAttribute('href', pr)
    await expect(prChip).toHaveAttribute('data-pr-state', 'open')
    await expect(prCard).not.toContainText('执行了')
    await expect(prCard).not.toContainText('Added MIKKA_MOCK.md')
    await expect(loop.chat).not.toContainText(`mock ${loop.device.id}`)
    await expect(loop.chat).not.toContainText("The agent's summary")
    await expect(loop.chat).not.toContainText('Report the result in this chat')
    await expect(loop.chat).not.toContainText(loop.runId)
    await expect(loop.chat).not.toContainText('list_agents')
    loop.checkpoint('chat-result-verified', 'Coordinator reported the result in chat and R-66 card showed its PR without a progress line')
    await testInfo.attach('03-completed-chat-and-pr-card', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })
    loop.completeAssertions()
  } finally { await loop.cleanup() }
})

test('Stopping a thread reaches the real daemon and keeps the draft editable while stopping', async ({ page, testAccounts }, testInfo) => {
  const loop = await setup(page, testInfo, testAccounts.scope)
  try {
    const composer = loop.thread.getByRole('textbox', { name: '告诉 mock 下一步做什么…', exact: true })
    // Hold only delivery of the real stop response while sampling optimistic UI.
    // requestRunStop and the daemon execute normally; no response is fabricated.
    // Without this boundary a fast daemon can finish before the draft assertion.
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1_000))
    let releaseResponse!: () => void
    const released = new Promise<void>(resolve => { releaseResponse = resolve })
    let held = false
    const path = new URL(page.url()).pathname
    const matcher = (url: URL) => url.pathname === path
    const holdStop = async (route: Route) => {
      if (!held && route.request().method() === 'POST' && route.request().headers()['next-action']) {
        held = true
        const actual = await route.fetch()
        await released
        await route.fulfill({ response: actual })
      } else await route.continue()
    }
    await page.route(matcher, holdStop)
    try {
      await loop.thread.getByRole('button', { name: '停止', exact: true }).click()
      await expect(loop.thread.getByText('正在停止…', { exact: true })).toBeVisible()
      await expect(composer).toBeEditable()
      await composer.fill('保留这个未发送的草稿')
      await expect(composer).toHaveValue('保留这个未发送的草稿')
      await expect.poll(() => held).toBe(true)
      await testInfo.attach('04-stop-requested-draft-editable', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })
    } finally {
      releaseResponse()
      // This is the only page route. Drain its real fetch/fulfill callback
      // before removing the last interceptor, which resumes pending requests.
      await page.unrouteAll({ behavior: 'wait' })
      await page.clock.resume()
    }
    await expect.poll(async () => (await loop.run()).status, { timeout: 30_000 }).toMatch(/^(cancelled|stopped)$/)
    expect((await loop.run()).stopRequestedAt).toBeTruthy()
    expect((await loop.run()).report?.publish?.pushed ?? false).toBe(false)
    expect((await service<ServiceEvidence>('/observations')).pullRequests).toEqual([])
    await expect(loop.thread.getByRole('textbox')).toHaveCount(0)
    loop.checkpoint('stop-completed', 'Stop request reached the real daemon; no PR was created')
    await testInfo.attach('05-stopped-thread', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })
    loop.completeAssertions()
  } finally { await loop.cleanup() }
})
