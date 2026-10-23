import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { Page, TestInfo } from '@playwright/test'
import { test, expect, register, app } from './fixtures'

// 本地目标 1000ms；GitHub Actions 共享机器抖动大，CI 上留 20% 余量（MIK-1）。
const budget = process.env.CI ? 1200 : 1000

async function seedHistory(page: Page, email: string) {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('性能验收必须使用独立的 E2E_DATABASE_URL。')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) {
    throw new Error('性能验收禁止写入业务数据库。')
  }
  const pool = new Pool({ connectionString, max: 1 })
  const current = randomUUID()
  const older = randomUUID()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    expect(user).toBeTruthy()
    await pool.query('INSERT INTO agent_sessions (id, "userId", title, "updatedAt") VALUES ($1, $2, $3, now()), ($4, $2, $5, now() - interval \'1 day\')', [current, user.id, '最新性能验收会话', older, '较早性能验收会话'])
    for (const [sessionId, prompts] of [[current, ['第一轮性能验收', '第二轮性能验收', '第三轮性能验收']], [older, ['较早的一轮提问']]] as const) {
      for (const [index, prompt] of prompts.entries()) {
        await pool.query('INSERT INTO agent_turns (id, "sessionId", "userId", prompt, completion, status, "attemptId", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval \'1 millisecond\')', [randomUUID(), sessionId, user.id, prompt, `root = TextContent("${prompt}的已保存正文")`, 'complete', randomUUID(), index])
      }
    }
  } finally {
    await pool.end()
  }
  const history = await page.request.get(app(`/api/agent/sessions?sessionId=${current}`))
  expect(history.status()).toBe(200)
  expect((await history.json()).turns).toHaveLength(3)
  return { current, older }
}

async function assertInteractiveWithinBudget(page: Page, info: TestInfo, name: string, start: number, expectedReply?: string) {
  const panel = page.getByRole('region', { name: 'Agent 对话工作区', exact: true })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  await page.waitForFunction(reply => {
    const visiblePanel = [...document.querySelectorAll<HTMLElement>('section[aria-label="Agent 对话工作区"]')].find(element => element.checkVisibility())
    if (!visiblePanel?.querySelector('textarea')) return false
    return !reply || [...visiblePanel.querySelectorAll<HTMLElement>('article[aria-label="Agent 回复"]')].some(element => element.checkVisibility() && element.innerText.includes(reply))
  }, expectedReply, { polling: 'raf' })
  await input.fill('加载完成验收')
  await page.waitForFunction(() => {
    const visiblePanel = [...document.querySelectorAll<HTMLElement>('section[aria-label="Agent 对话工作区"]')].find(element => element.checkVisibility())
    return visiblePanel?.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.disabled === false
  }, undefined, { polling: 'raf' })
  const timing = await page.evaluate(async startTime => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    return {
      elapsed: performance.now() - startTime,
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
    }
  }, start)
  await info.attach(name, { body: JSON.stringify(timing, null, 2), contentType: 'application/json' })
  expect(timing.elapsed, `${name}：完整会话可见、输入事件生效并完成绘制，必须小于 ${budget}ms`).toBeLessThan(budget)
  await input.fill('')
  return panel
}

test('Agent 首次进入、完整历史刷新、返回和新任务均小于 1 秒 @performance', async ({ page }, info) => {
  const { email } = await register(page)
  const { older } = await seedHistory(page, email)
  const historyRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === app('/api/agent/sessions')) historyRequests.push(request.url())
  })
  await page.reload()

  const firstStart = await page.evaluate(() => performance.now())
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  let panel = await assertInteractiveWithinBudget(page, info, '首次进入', firstStart, '第三轮性能验收的已保存正文')
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(3)
  await expect(page).toHaveURL(/section=agent/)
  await expect(panel.getByText(/账号会话|正在恢复聊天历史|对话按账号保存|不读取或修改工作区|底部输入框保留独立草稿/)).toHaveCount(0)
  expect(historyRequests).toHaveLength(1)
  expect(new URL(historyRequests[0]).searchParams.has('sessionId')).toBe(false)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.reload({ waitUntil: 'domcontentloaded' })
  panel = await assertInteractiveWithinBudget(page, info, '无缓存刷新并恢复完整历史', 0, '第三轮性能验收的已保存正文')
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(3)
  expect(historyRequests).toHaveLength(2)
  expect(new URL(historyRequests[1]).searchParams.has('sessionId')).toBe(false)

  await page.getByRole('button', { name: '我的任务', exact: true }).click()
  const returnStart = await page.evaluate(() => performance.now())
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  panel = await assertInteractiveWithinBudget(page, info, '返回会话', returnStart, '第三轮性能验收的已保存正文')
  expect(historyRequests).toHaveLength(2)

  await expect(panel.getByRole('button', { name: '运行记录', exact: true })).toHaveCount(0)
  const selectionStart = await page.evaluate(() => performance.now())
  await panel.getByRole('button', { name: /^切换会话：/ }).click()
  await page.getByRole('option', { name: /^较早性能验收会话/ }).click()
  panel = await assertInteractiveWithinBudget(page, info, '切换真实历史会话', selectionStart, '较早的一轮提问的已保存正文')
  expect(historyRequests).toHaveLength(3)
  expect(new URL(historyRequests[2]).searchParams.get('sessionId')).toBe(older)

  const resetStart = await page.evaluate(() => performance.now())
  await panel.getByRole('button', { name: '新任务', exact: true }).click()
  panel = await assertInteractiveWithinBudget(page, info, '新任务', resetStart)
  await expect(panel.getByRole('region', { name: '推荐建议', exact: true })).toBeVisible()
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(0)
  expect(historyRequests).toHaveLength(3)
  await expect(panel.getByText(/发送消息后|对话按账号保存|账号会话/)).toHaveCount(0)
})

test('历史读取保持账号隔离，并正确处理空会话与无效会话', async ({ page, browser }) => {
  const { email } = await register(page)
  const { current } = await seedHistory(page, email)
  const missing = await page.request.get(app(`/api/agent/sessions?sessionId=${randomUUID()}`))
  expect(missing.status()).toBe(404)
  const fresh = await page.request.get(app('/api/agent/sessions?new=1'))
  expect(fresh.status()).toBe(200)
  expect(await fresh.json()).toMatchObject({ sessionId: null, turns: [] })
  const context = await browser.newContext()
  try {
    const otherPage = await context.newPage()
    const unauthenticated = await otherPage.request.get(app(`/api/agent/sessions?sessionId=${current}`))
    expect(unauthenticated.status()).toBe(401)
    await register(otherPage)
    const forbidden = await otherPage.request.get(app(`/api/agent/sessions?sessionId=${current}`))
    expect(forbidden.status()).toBe(404)
    const empty = await otherPage.request.get(app('/api/agent/sessions'))
    expect(await empty.json()).toEqual({ sessions: [], sessionId: null, turns: [] })
    await otherPage.getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(otherPage.getByRole('region', { name: '推荐建议', exact: true })).toBeVisible()
    await expect(otherPage.getByText('第三轮性能验收的已保存正文', { exact: true })).toHaveCount(0)
  } finally {
    await context.close()
  }
})
