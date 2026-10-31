import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, register, seedTask, openIssueFromSearch, app } from './fixtures'

// Server responses are fixtures; the merge itself is covered by lib/factory/merge.db.test.ts.
type Call = { operation: string; input: Record<string, unknown> }
const shot = async (page: Page, name: string) => {
  const size = page.viewportSize()
  for (const [suffix, viewport] of [['', size], ['-mobile', { width: 390, height: 844 }]] as const) {
    if (viewport) await page.setViewportSize(viewport)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(150)
      await page.screenshot({ path: test.info().outputPath(`shots/fe2-${name}${suffix}-${scheme}.png`) })
    }
  }
  if (size) await page.setViewportSize(size)
  await page.emulateMedia({ colorScheme: 'light' })
}

async function setup(page: Page, opts: { taskId?: string; stage?: string; status?: string; pullRequest?: string; ledger: (ids: { candidateId: string; binding: Record<string, unknown> }) => Record<string, unknown>; onPost?: (call: Call) => { status: number; json: unknown } }) {
  await register(page)
  const title = `Factory A2 ${randomUUID()}`
  const issueId = await seedTask(page, title)
  const taskId = opts.taskId ?? randomUUID(), candidateId = randomUUID()
  const binding = { taskId, issueId, attemptId: randomUUID(), revision: 1, candidateId }
  const candidate = { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'run report' }
  const calls: Call[] = []
  const ledger = { binding, ...opts.ledger({ candidateId, binding }) }
  await page.route('**/api/factory/tasks?issueId=*', route => route.fulfill({ json: { tasks: [{ id: taskId, issueId, stage: opts.stage ?? 'approval', status: opts.status ?? 'pending', reason: '独立检查通过', candidateId, candidateRunId: null, isSkillCandidate: false }] } }))
  await page.route(`**/api/factory/tasks/${taskId}`, route => route.fulfill({ json: { checks: [], delivery: { candidateSha: candidate.sha, pullRequest: opts.pullRequest ? { url: opts.pullRequest, state: 'open' } : null, repository: candidate.repository, environment: null, previewUrl: null, databaseBranch: null, deploymentEnvironment: null } } }))
  await page.route(`**/api/factory/tasks/${taskId}/approval*`, async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET') {
      if (url.searchParams.get('view') === 'ledger') return route.fulfill({ json: ledger })
      return route.fulfill({ json: { binding, evidenceDigest: 'b'.repeat(64), manifest: { candidate, artifacts: [{ artifact: 'run-report:fixture', kind: 'report', stage: 'review' }] } } })
    }
    const call = route.request().postDataJSON() as Call
    calls.push(call)
    const reply = opts.onPost?.(call) ?? { status: 200, json: {} }
    return route.fulfill(reply)
  })
  await openIssueFromSearch(page, title)
  await page.getByRole('button', { name: 'Factory 验收', exact: true }).click()
  // No producing thread in these fixtures: acceptance opens alone, beside the issue.
  const dialog = page.getByRole('region', { name: 'Factory 验收', exact: true })
  await expect(dialog.getByRole('heading', { name: 'Factory 验收' })).toBeVisible()
  return { dialog, calls, binding }
}

test('退回修改 hides without server support', async ({ page }) => {
  const { dialog } = await setup(page, { ledger: () => ({ approvals: [], publications: [] }) })
  await expect(dialog.getByText('待你确认', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByRole('button', { name: '退回修改' })).toHaveCount(0)
})

// The first send-back is refused on purpose (a 4xx, so the 5xx guard stays strict); the browser logs it once.
const sendBackTask = randomUUID()
test.describe('send-back', () => {
  test.use({ expectedConsoleErrors: [{ path: app(`/api/factory/tasks/${sendBackTask}/approval`), message: 'Failed to load resource: the server responded with a status of 409 (Conflict)' }] })
  test('send-back: note, submitting, failure keeps the note, resubmit closes', async ({ page }) => {
    let attempts = 0
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const { dialog, calls, binding } = await setup(page, {
      taskId: sendBackTask,
      ledger: () => ({ approvals: [], publications: [], capabilities: { reject: true } }),
      onPost: () => (++attempts === 1 ? { status: 409, json: { error: 'factoryStale' } } : { status: 200, json: {} }),
    })
    await page.route('**/api/factory/tasks/*/approval', async route => {
      if (route.request().method() === 'POST' && attempts === 0) await held
      return route.fallback()
    })
    await dialog.getByRole('button', { name: '退回修改' }).click()
    const note = page.getByRole('dialog', { name: '退回修改' })
    await expect(note.getByRole('button', { name: '退回', exact: true })).toBeDisabled()
    await note.getByRole('textbox', { name: '退回备注' }).fill('标题和截图不一致')
    await shot(page, `reject-editing-${test.info().project.name}`)
    await note.getByRole('button', { name: '退回', exact: true }).click()
    await expect(note.getByRole('button', { name: '提交中…' })).toBeDisabled()
    await shot(page, `reject-submitting-${test.info().project.name}`)
    release()
    await expect(note.getByText('提交失败，请重试')).toBeVisible()
    await expect(note.getByRole('textbox', { name: '退回备注' })).toHaveValue('标题和截图不一致')
    await shot(page, `reject-failed-${test.info().project.name}`)
    await note.getByRole('button', { name: '重新提交' }).click()
    await expect(note).toBeHidden()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ operation: 'reject', input: { binding, note: '标题和截图不一致' } })
  })
})

const pr = 'https://github.com/alexj11324/Mikka/pull/418'

// GitHub refuses the merge on purpose (409); the browser logs it once.
const refusedTask = randomUUID()
test.describe('refused merge', () => {
  test.use({ expectedConsoleErrors: [{ path: app(`/api/factory/tasks/${refusedTask}/approval`), message: 'Failed to load resource: the server responded with a status of 409 (Conflict)' }] })
  test('验收并合并 that GitHub refuses keeps the task waiting with the reason and 在 GitHub 打开', async ({ page }) => {
    const { dialog, calls, binding } = await setup(page, {
      taskId: refusedTask,
      pullRequest: pr,
      ledger: () => ({ approvals: [], publications: [], merges: [] }),
      onPost: () => ({ status: 409, json: { error: 'githubMergeBlocked', pullRequestUrl: pr } }),
    })
    await expect(dialog.getByText(/有效|批准/)).toHaveCount(0)
    await dialog.getByRole('button', { name: '验收并合并' }).click()
    await expect(dialog.getByText('无法合并')).toBeVisible()
    await expect(dialog.getByText('检查或审批未通过')).toBeVisible()
    await expect(dialog.getByRole('link', { name: '在 GitHub 打开' })).toHaveAttribute('href', pr)
    await expect(dialog.getByRole('button', { name: '验收并合并' })).toBeVisible()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ operation: 'accept', input: { binding, eventId: expect.any(String) } })
    await shot(page, `merge-refused-${test.info().project.name}`)
  })
})

test('a merged candidate reads 已合并 and opens the PR', async ({ page }) => {
  const { dialog } = await setup(page, {
    stage: 'publish',
    status: 'passed',
    pullRequest: pr,
    ledger: ({ candidateId }) => ({ approvals: [], publications: [], merges: [{ id: randomUUID(), candidateId, status: 'merged', source: 'mikka', code: null, pullRequestUrl: pr, createdAt: new Date().toISOString() }] }),
  })
  await expect(dialog.getByText('已合并', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByRole('link', { name: '在 GitHub 打开' })).toHaveAttribute('href', pr)
  await expect(dialog.getByRole('button', { name: '验收并合并' })).toHaveCount(0)
  await shot(page, `merged-${test.info().project.name}`)
})
