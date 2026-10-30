import { randomUUID } from 'node:crypto'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

// Design evidence only (run with E2E_EVIDENCE_DIR): each acceptance state in light, dark and mobile.
test.skip(!process.env.E2E_EVIDENCE_DIR, 'evidence shots run only with E2E_EVIDENCE_DIR')

type Status = 'approved' | 'failed' | 'checking'
const states: Status[] = ['approved', 'failed', 'checking']

async function shoot(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  for (const [suffix, size] of [['', { width: 1440, height: 960 }], ['-mobile', { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(150)
      await page.screenshot({ path: testInfo.outputPath(`${name}${suffix}-${scheme}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
}

for (const status of [...states, 'evidence' as const]) {
  test(`acceptance shots: ${status}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await register(page)
    const title = `Factory shots ${randomUUID()}`
    const issueId = await seedTask(page, title)
    const taskId = randomUUID(), candidateId = randomUUID(), approvalId = randomUUID()
    const binding = { taskId, issueId, attemptId: randomUUID(), revision: 2, candidateId }
    const candidate = { sha: '3f9c2ab' + 'e'.repeat(33), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'home page' }
    const approval = { id: approvalId, candidateId, candidate, action: 'publish_vercel_preview', target: 'vercel:mikka', targetEnvironment: 'preview', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null, createdAt: new Date().toISOString() }
    const publication = status === 'failed' ? 'failed' : status === 'checking' ? 'uncertain' : null
    const stage = status === 'evidence' ? 'approval' : 'publish'
    const ledger = { binding, approvals: status === 'evidence' ? [] : [approval], publications: publication ? [{ id: randomUUID(), approvalId, status: publication, request: {}, receipt: null }] : [] }
    await page.route('**/api/factory/tasks?issueId=*', route => route.fulfill({ json: { tasks: [{ id: taskId, issueId, stage, status: 'pending', reason: '独立检查通过', candidateId, candidateRunId: null, isSkillCandidate: false }] } }))
    await page.route(`**/api/factory/tasks/${taskId}/approval*`, route => {
      const url = new URL(route.request().url())
      if (url.searchParams.has('artifact')) return route.fulfill({ json: { raw: '{\n  "checks": "passed",\n  "lighthouse": 97,\n  "screenshots": 4\n}' } })
      if (url.searchParams.get('view') === 'ledger') return route.fulfill({ json: ledger })
      return route.fulfill({ json: { binding, evidenceReadId: randomUUID(), evidenceDigest: 'b'.repeat(64), manifest: { candidate, artifacts: [{ artifact: 'review-report.json', kind: 'report', stage: 'review' }, { artifact: 'home.png', kind: 'screenshot', stage: 'verify' }] } } })
    })
    await openIssueFromSearch(page, title)
    await page.getByRole('button', { name: /Factory 验收/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Factory 验收' })).toBeVisible()
    if (status === 'evidence') {
      await dialog.getByRole('button', { name: 'review-report.json' }).click()
      await expect(page.getByText('"lighthouse": 97')).toBeVisible()
      await shoot(page, testInfo, 'evidence-viewer')
      return
    }
    await expect(dialog.getByText(status === 'approved' ? '已批准' : status === 'failed' ? '发布失败' : '发布待核对', { exact: true }).first()).toBeVisible()
    await expect(dialog.getByText('3f9c2ab', { exact: true }).first()).toBeVisible()
    await shoot(page, testInfo, status)
  })
}
