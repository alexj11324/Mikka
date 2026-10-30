import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

// Server responses are fixtures: send-back and a failed publish have no backend yet (reject operation; BE-3).
type Call = { operation: string; input: Record<string, unknown> }
const shot = async (page: Page, name: string) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: test.info().outputPath(`../shots/fe2-${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function setup(page: Page, opts: { stage?: string; ledger: (ids: { candidateId: string; binding: Record<string, unknown> }) => Record<string, unknown>; onPost?: (call: Call) => { status: number; json: unknown } }) {
  await register(page)
  const title = `Factory A2 ${randomUUID()}`
  const issueId = await seedTask(page, title)
  const taskId = randomUUID(), candidateId = randomUUID()
  const binding = { taskId, issueId, attemptId: randomUUID(), revision: 1, candidateId }
  const candidate = { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'run report' }
  const calls: Call[] = []
  const ledger = { binding, ...opts.ledger({ candidateId, binding }) }
  await page.route('**/api/factory/tasks?issueId=*', route => route.fulfill({ json: { tasks: [{ id: taskId, issueId, stage: opts.stage ?? 'approval', status: 'pending', reason: '独立检查通过', candidateId, candidateRunId: null, isSkillCandidate: false }] } }))
  await page.route(`**/api/factory/tasks/${taskId}/approval*`, async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET') {
      if (url.searchParams.get('view') === 'ledger') return route.fulfill({ json: ledger })
      return route.fulfill({ json: { binding, evidenceReadId: randomUUID(), evidenceDigest: 'b'.repeat(64), manifest: { candidate, artifacts: [{ artifact: 'run-report:fixture', kind: 'report', stage: 'review' }] } } })
    }
    const call = route.request().postDataJSON() as Call
    calls.push(call)
    const reply = opts.onPost?.(call) ?? { status: 200, json: {} }
    return route.fulfill(reply)
  })
  await openIssueFromSearch(page, title)
  await page.getByRole('button', { name: /Factory 验收/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Factory 验收' })).toBeVisible()
  return { dialog, calls, binding }
}

const approval = (candidateId: string, id = randomUUID()) => ({ id, candidateId, candidate: { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'run report' }, action: 'deploy', target: 'web', targetEnvironment: 'preview', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null, createdAt: new Date().toISOString() })

test('退回修改 hides without server support', async ({ page }) => {
  const { dialog } = await setup(page, { ledger: () => ({ approvals: [], publications: [] }) })
  await expect(dialog.getByText('待你确认', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByRole('button', { name: '退回修改' })).toHaveCount(0)
})

test('send-back: note, submitting, failure keeps the note, resubmit closes', async ({ page }) => {
  let attempts = 0
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const { dialog, calls, binding } = await setup(page, {
    ledger: () => ({ approvals: [], publications: [], capabilities: { reject: true } }),
    onPost: () => (++attempts === 1 ? { status: 500, json: { error: 'down' } } : { status: 200, json: {} }),
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

test('publish failed keeps the approval and offers publish again', async ({ page }) => {
  const id = randomUUID()
  const { dialog } = await setup(page, { ledger: ({ candidateId }) => ({ approvals: [approval(candidateId, id)], publications: [{ id: randomUUID(), approvalId: id, status: 'failed', request: {}, receipt: null }] }) })
  await expect(dialog.getByText('发布失败，批准仍保留')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '撤销批准' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '发布', exact: true })).toBeVisible()
  await shot(page, `publish-failed-${test.info().project.name}`)
})

test('approvals on an older candidate read 已失效 with no actions', async ({ page }) => {
  const { dialog } = await setup(page, { stage: 'verify', ledger: () => ({ approvals: [approval(randomUUID())], publications: [] }) })
  await expect(dialog.getByText('已失效', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByRole('button', { name: /批准|发布|退回修改/ })).toHaveCount(0)
  await shot(page, `invalidated-${test.info().project.name}`)
})
