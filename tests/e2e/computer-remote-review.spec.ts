import { test, expect, register, app } from './fixtures'

test('remote owner review stays available while model waits; decision queues, never claims execution (UI fixture)', async ({ page }, testInfo) => {
  const noOwner = await page.request.post(app('/api/agent/computer'), { data: { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), approve: true } })
  expect(noOwner.status()).toBe(401)
  await register(page)
  const invalid = await page.request.post(app('/api/agent/computer'), { headers: { origin: new URL(page.url()).origin }, data: { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), approve: true, operation: { tool: 'type', text: 'tampered' } } })
  expect(invalid.status()).toBe(400)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  let release!: () => void
  const waitForReview = new Promise<void>(resolve => { release = resolve })
  let sessionId = '', pending = true, decisions = 0
  const id = crypto.randomUUID()
  await page.route('**/api/agent/computer**', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ id, sessionId, approve: true })
      decisions++; pending = false
      await route.fulfill({ json: { status: 'approved' } })
    } else await route.fulfill({ json: { desktop: 'http://fixture.invalid:3211', requests: pending ? [{ id, operation: { tool: 'type', text: 'Mikka scripted fixture' }, expiresAt: new Date(Date.now() + 60000).toISOString() }] : [] } })
  })
  await page.route('**/api/agent', async route => {
    sessionId = route.request().postDataJSON().sessionId
    await waitForReview
    await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: 'data: {"type":"start"}\n\ndata: {"type":"text-start","id":"fixture"}\n\ndata: {"type":"text-delta","id":"fixture","delta":"Scripted review fixture finished; not a live desktop test."}\n\ndata: {"type":"text-end","id":"fixture"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n' })
  })
  try {
    await panel.getByRole('textbox', { name: '向 Agent 提问' }).fill('Scripted remote review UI fixture')
    await panel.getByRole('button', { name: '发送消息', exact: true }).click()
    const approval = panel.getByRole('region', { name: '远程桌面操作授权' })
    await expect(approval).toBeVisible()
    await expect(approval).toContainText('Mikka scripted fixture')
    await expect(panel.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('remote-review-during-model-wait.png'), fullPage: true })
    await approval.getByRole('button', { name: '授权并执行一次', exact: true }).click()
    await expect.poll(() => decisions).toBe(1)
    await expect(panel).not.toContainText('操作已执行。不会自动重复执行。')
    release()
    await expect(panel).toContainText('Scripted review fixture finished; not a live desktop test.')
    await expect(approval).toHaveCount(0)
  } finally { release() }
})
