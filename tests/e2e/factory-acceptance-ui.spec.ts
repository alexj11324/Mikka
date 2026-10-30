import { randomUUID } from 'node:crypto'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

// The server responses are fixtures: this checks the acceptance surface, not activation evidence.
test('the issue page reviews Factory evidence, enables the skill and reconciles the publication', async ({ page }) => {
  await register(page)
  const title = `Factory acceptance ${randomUUID()}`
  const issueId = await seedTask(page, title)
  const taskId = randomUUID(), candidateId = randomUUID(), approvalId = randomUUID(), readId = randomUUID(), publicationId = randomUUID()
  const binding = { taskId, issueId, attemptId: randomUUID(), revision: 1, candidateId }
  const publishBinding = { ...binding, attemptId: randomUUID(), revision: 2 }
  const candidate = { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'run report' }
  const reference = 'https://mikka-preview.vercel.app'
  const calls: { operation: string; input: Record<string, unknown> }[] = []
  let ledger: Record<string, unknown> = { binding, approvals: [], publications: [] }
  await page.route('**/api/factory/tasks?issueId=*', route => route.fulfill({ json: { tasks: [{ id: taskId, issueId, stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId, candidateRunId: null, isSkillCandidate: true }] } }))
  await page.route(`**/api/factory/tasks/${taskId}`, route => route.fulfill({ json: { checks: [], delivery: { candidateSha: candidate.sha, pullRequest: null, repository: candidate.repository, environment: null, previewUrl: null, databaseBranch: null, deploymentEnvironment: null } } }))
  await page.route(`**/api/factory/tasks/${taskId}/approval*`, async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET') {
      if (url.searchParams.has('artifact')) return route.fulfill({ json: { raw: 'independent review evidence' } })
      if (url.searchParams.get('view') === 'ledger') return route.fulfill({ json: ledger })
      return route.fulfill({ json: { binding, evidenceReadId: readId, evidenceDigest: 'b'.repeat(64), manifest: { candidate, artifacts: [{ artifact: 'run-report:fixture', kind: 'report', stage: 'review' }] } } })
    }
    const body = route.request().postDataJSON() as { operation: string; input: Record<string, unknown> }
    calls.push(body)
    if (body.operation === 'approve') {
      ledger = { binding: publishBinding, approvals: [{ id: approvalId, candidateId, candidate, action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: 'preview', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null }], publications: [] }
      return route.fulfill({ json: { binding: publishBinding, approvalId } })
    }
    if (body.operation === 'publish') {
      ledger = { binding: publishBinding, approvals: (ledger.approvals as unknown[]), publications: [{ id: publicationId, approvalId, status: 'reserved', request: body.input, receipt: null }] }
      return route.fulfill({ status: 202, json: { publicationId, status: 'pending', nextOperation: 'reconcile' } })
    }
    ledger = { binding: publishBinding, approvals: (ledger.approvals as unknown[]), publications: [{ id: publicationId, approvalId, status: 'succeeded', request: (ledger.publications as { request: unknown }[])[0].request, receipt: { verifiedTarget: { reference } } }] }
    return route.fulfill({ json: { publicationId, receipt: { verifiedTarget: { reference } }, binding: publishBinding } })
  })
  await openIssueFromSearch(page, title)
  await page.getByRole('button', { name: '技能验收', exact: true }).click()
  const dialog = page.getByRole('region', { name: '技能验收', exact: true })
  await expect(dialog.getByRole('heading', { name: '技能验收' })).toBeVisible()
  // Text evidence is named by its stage and kind, never by its raw reference.
  await expect(dialog.getByText('run-report:fixture')).toHaveCount(0)
  await dialog.getByRole('button', { name: '审查报告' }).click()
  await expect(page.getByText('independent review evidence')).toBeVisible()
  await page.getByRole('button', { name: '关闭证据' }).click()
  await dialog.getByRole('button', { name: '启用' }).click()
  await expect.poll(() => calls.length).toBe(2)
  expect(calls[0]).toMatchObject({ operation: 'approve', input: { binding, candidate, action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: 'preview', evidenceReadId: readId, evidenceDigest: 'b'.repeat(64) } })
  expect(calls[1]).toMatchObject({ operation: 'publish', input: { binding: publishBinding, approvalId, action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: 'preview' } })
  await expect(dialog.getByText('发布中', { exact: true }).first()).toBeVisible()
  await dialog.getByRole('button', { name: '核对发布' }).click()
  await expect.poll(() => calls.length).toBe(3)
  expect(calls[2]).toEqual({ operation: 'reconcile', input: { ...calls[1].input, publicationId } })
  await expect(dialog.getByText('已启用', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByRole('link', { name: /预览/ })).toHaveAttribute('href', reference)
})
