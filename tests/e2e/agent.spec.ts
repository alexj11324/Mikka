import { test as apiTest } from '@playwright/test'
import { test, expect, register, app, openSearch } from './fixtures'
import { seedLegacyHistory } from './legacy-chat-fixture'

apiTest('旧生成 POST 已退役，共享配图 GET 仍执行认证', async ({ request }) => {
  const generated = await request.post(app('/api/agent'), { data: { prompt: 'must never reach a model' } })
  expect(generated.status()).toBe(405)
  const image = await request.get(app('/api/agent?q=public-documentation'))
  expect(image.status()).toBe(401)
})

test('历史仅可读取，原始数据保留，新对话动作进入当前 Bot', async ({ page }, info) => {
  const { email } = await register(page)
  const saved = await seedLegacyHistory(email)
  const generationRequests: string[] = []
  const computerRequests: string[] = []
  page.on('request', request => {
    if (/\/api\/(?:bots\/.*\/computer|computer\/)/.test(new URL(request.url()).pathname)) computerRequests.push(request.url())
    if (new URL(request.url()).pathname === app('/api/agent') && request.method() === 'POST') generationRequests.push(request.url())
  })
  await page.reload()
  await expect(page.getByRole('button', { name: `历史：${saved.title}`, exact: true })).toHaveCount(0)
  const search = await openSearch(page)
  await search.getByRole('option').filter({ hasText: `历史：${saved.title}` }).click()
  const archive = page.getByTestId('legacy-chat-archive')
  await expect(archive).toBeVisible()
  await expect(archive.getByText('已保存的公开测试历史正文', { exact: true })).toBeVisible()
  await expect(archive.getByText('此对话仅供查看。请在 Bot 对话中继续工作。', { exact: true })).toBeVisible()
  await expect(archive.locator('form, textarea')).toHaveCount(0)
  await expect(archive.getByText('受控历史失败信息', { exact: true })).toBeVisible()
  await expect(archive.getByText('此历史回复未完成。', { exact: true })).toBeVisible()
  const body = archive.getByTestId('archived-reply').first()
  await expect(body.locator('button, input, select, textarea, iframe, canvas, [inert], [role="button"], [tabindex]')).toHaveCount(0)
  await expect(body.getByText('继续细化', { exact: true })).toBeVisible()
  for (const text of ['第一项历史详情', '第二项历史详情', '第一页历史正文', '第二页历史正文', '历史电脑任务快照']) {
    await expect(body.getByText(text, { exact: true })).toBeVisible()
  }
  const accessibility = await archive.ariaSnapshot()
  for (const text of ['已保存的公开测试历史正文', '第二项历史详情', '第二页历史正文', '历史电脑任务快照', '受控历史失败信息', '此历史回复未完成。']) expect(accessibility).toContain(text)
  const answer = body.getByText('已保存的公开测试历史正文', { exact: true })
  const selectedText = await answer.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    const selected = selection.toString()
    selection.removeAllRanges()
    return selected
  })
  expect(selectedText).toBe('已保存的公开测试历史正文')
  // Pointer and keyboard interaction with static historical action text must remain harmless.
  await body.getByText('继续细化', { exact: true }).click()
  await body.getByText('继续细化', { exact: true }).dispatchEvent('keydown', { key: 'Enter', code: 'Enter' })
  expect(generationRequests).toEqual([])
  expect(computerRequests).toEqual([])
  await info.attach('archive-accessibility-tree', { body: accessibility, contentType: 'text/yaml' })
  await info.attach('archive-accessible-static-reply', { body: await archive.screenshot(), contentType: 'image/png' })
  const stored = await page.request.get(app(`/api/agent/sessions?sessionId=${saved.id}`))
  expect(stored.status()).toBe(200)
  expect((await stored.json()).turns[0].completion).toBe(saved.completion)
  await page.getByRole('list', { name: 'Bot', exact: true }).getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect(archive).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
  // The Coordinator's chat is the bare address (R-80).
  await expect(page).not.toHaveURL(/[?&](section|bot)=/)
  expect(generationRequests).toEqual([])
  await info.attach('retirement-http-evidence', { body: JSON.stringify({ retiredPost: 405, ownerHistory: stored.status(), noGenerationRequests: generationRequests.length, computerRequests: computerRequests.length, archivedTextSelectable: true, allPanelsReadable: true, botInputVisible: true }), contentType: 'application/json' })
})

test('归档历史仍拒绝另一个账号读取', async ({ page, browser, baseURL }) => {
  const { email } = await register(page)
  const saved = await seedLegacyHistory(email)
  const otherContext = await browser.newContext({ baseURL })
  try {
    const otherPage = await otherContext.newPage()
    await register(otherPage)
    const response = await otherPage.request.get(app(`/api/agent/sessions?sessionId=${saved.id}`))
    expect(response.status()).toBe(404)
  } finally { await otherContext.close() }
})
