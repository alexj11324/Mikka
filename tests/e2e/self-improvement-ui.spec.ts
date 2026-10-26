import { randomUUID } from 'node:crypto'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

// UI contract test: the server responses are fixtures, not activation evidence.
test('human reviews evidence before approving and activating the selected Skill target', async ({ page }) => {
  await register(page)
  const title = `Skill review ${randomUUID()}`
  await seedTask(page, title)
  const taskId = randomUUID(), candidateId = randomUUID(), approvalId = randomUUID(), readId = randomUUID()
  const binding = { taskId, issueId: randomUUID(), attemptId: randomUUID(), revision: 1, candidateId }
  const publishBinding = { ...binding, attemptId: randomUUID(), revision: 2 }
  const publicationId = randomUUID()
  const candidate = { sha: 'a'.repeat(40), repository: 'repo', environment: 'device', scope: 'run report' }
  const calls: { operation: string; input: Record<string, unknown> }[] = []
  let stage = 'approval', status = 'pending', revoked = false, failApproval = true
  let reservedRequest: Record<string, unknown> | null = null
  await page.route('**/api/factory/tasks?issueId=*', route => route.fulfill({ json: { tasks: [{ id: taskId, stage, status, isSkillCandidate: true }, { id: randomUUID(), stage: 'approval', status: 'pending', isSkillCandidate: false }] } }))
  await page.route(`**/api/factory/tasks/${taskId}/approval*`, async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET') {
      if (url.searchParams.has('artifact')) return route.fulfill({ json: { raw: 'independent review evidence' } })
      if (url.searchParams.get('view') === 'ledger') return route.fulfill({ json: { binding: publishBinding, approvals: [{ id: approvalId, candidateId, action: 'activate_skill', revokedAt: revoked ? new Date().toISOString() : null, expiresAt: new Date(Date.now() + 3600000).toISOString(), targetEnvironment: 'preview' }], publications: reservedRequest ? [{ id: publicationId, approvalId, candidateId, action: 'activate_skill', status: status === 'passed' ? 'succeeded' : 'reserved', receipt: status === 'passed' ? { reference: 'fixture' } : null, request: reservedRequest }] : [] } })
      return route.fulfill({ json: { binding, evidenceReadId: readId, evidenceDigest: 'b'.repeat(64), manifest: { candidate, skill: { markdown: 'Candidate instructions', evaluation: { result: 'passed' } }, artifacts: [{ artifact: 'run-report:fixture', stage: 'review' }] } } })
    }
    const body = route.request().postDataJSON() as { operation: string; input: Record<string, unknown> }
    calls.push(body)
    if (body.operation === 'approve') {
      if (failApproval) { failApproval = false; return route.fulfill({ status: 409, json: { error: 'factoryEvidenceMismatch' } }) }
      stage = 'publish'; return route.fulfill({ json: { binding: publishBinding, approvalId } })
    }
    if (body.operation === 'publish') { reservedRequest = body.input; return route.fulfill({ status: 202, json: { publicationId, status: 'pending', nextOperation: 'reconcile' } }) }
    status = 'passed'; return route.fulfill({ json: { binding: publishBinding, receipt: { reference: 'fixture' } } })
  })
  await openIssueFromSearch(page, title)
  await expect(page.getByRole('button', { name: /查看候选版本/ })).toHaveCount(1)
  await page.getByRole('button', { name: /查看候选版本/ }).click()
  await expect(page.getByText('Candidate instructions')).toBeVisible()
  await expect(page.getByText(/independent review evidence/)).toBeVisible()
  const approve = page.getByRole('button', { name: '批准启用' })
  await expect(approve).toBeDisabled()
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await approve.click()
  await expect(page.getByRole('alert').filter({ hasText: '操作未完成' })).toBeVisible()
  await approve.click()
  expect(calls[1].input).toMatchObject({ binding, candidate, action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: 'preview', evidenceReadId: readId, evidenceDigest: 'b'.repeat(64) })
  await page.getByRole('button', { name: '启用已批准的 Skill' }).click()
  await expect.poll(() => calls.length).toBeGreaterThanOrEqual(3)
  expect(calls[2].input).toMatchObject({ binding: publishBinding, approvalId, action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: 'preview' })
  await expect(page.getByRole('alert').filter({ hasText: '操作未完成' })).toBeVisible()
  await page.getByRole('button', { name: '启用已批准的 Skill' }).click()
  await expect.poll(() => calls.length).toBeGreaterThanOrEqual(4)
  expect(calls[3]).toEqual({ operation: 'reconcile', input: { ...calls[2].input, publicationId } })
  await expect(page.getByText('已记录启用')).toBeVisible()
  revoked = true
  await page.reload()
  await openIssueFromSearch(page, title)
  await page.getByRole('button', { name: /继续启用/ }).click()
  await expect(page.getByText('已记录启用')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '启用已批准的 Skill' })).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: '操作未完成' })).toBeVisible()
})
