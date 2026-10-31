import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask, app } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Choice card acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

async function shoot(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const path = testInfo.outputPath(`${name}-${scheme}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`${name}-${scheme}`, { path, contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const clarify = 'root = Stack([intro, q])\nintro = TextContent("好的。")\nq = BeQuestions("官网首页在手机上太慢了，压到 2 秒以内", [{id:"net", title:"先确认一件事：2 秒按哪种网络来算？", options:[{value:"4g", label:"手机 4G（Lighthouse 移动端）"}, {value:"wifi", label:"桌面宽带"}, {value:"both", label:"两种都要到 2 秒"}, {value:"none", label:"不设线，越快越好"}]}])'
const dispatchFailed = (task: string, noKey = false) => `root = Stack([q])\nq = BeQuestions("派发失败：设备不在线", [{id:"route", title:"派不出去：Alex 的 MacBook 不在线。等它上线，还是在 Mikka Cloud 上运行？", options:[{value:"wait", label:"Wait for it"}, {value:"cloud", label:"Run on Mikka Cloud"${noKey ? ', action:"cloudKeySettings"' : ''}}]}], "${task}")`

// Dispatch option labels are English on purpose: the card localizes them by value.
// Visual and interaction coverage of stored replies; the Factory clarify answer itself is the person's next message.
async function seed(email: string, messages: object[]) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    for (const [index, message] of messages.entries()) await pool.query('INSERT INTO coordinator_messages (id, "userId", position, message) VALUES ($1, $2, $3, $4)', [randomUUID(), user.id, index + 1, JSON.stringify(message)])
  } finally { await pool.end() }
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`clarify choice card: answered after reload, then a dispatch-failure choice sends the picked option (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const { email } = await register(page)
    const task = await seedTask(page, '首页加载提速')
    await seed(email, [
      { role: 'user', content: '官网首页在手机上太慢了，压到 2 秒以内' },
      { role: 'assistant', content: clarify },
      { role: 'user', content: '手机 4G（Lighthouse 移动端）' },
      { role: 'assistant', content: dispatchFailed(task) },
    ])
    await page.goto(app('/?section=coordinator'))
    const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
    const first = chat.getByRole('group', { name: '先确认一件事：2 秒按哪种网络来算？' })
    // Answered rows stay disabled buttons (no height or colour jump); the picked one is pressed.
    await expect(first.getByRole('button', { name: /手机 4G/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(first.getByRole('button', { name: /手机 4G/ })).toBeDisabled()
    await expect(first.getByRole('button', { name: /桌面宽带/ })).toBeDisabled()
    const second = chat.getByRole('group', { name: /派不出去/ })
    const cloud = second.getByRole('button', { name: /在 Mikka Cloud 上运行/ })
    await expect(cloud).toBeEnabled()
    await expect(second.locator('[data-slot]').filter({ hasText: '首页加载提速' }).first()).toBeVisible()
    await shoot(page, testInfo, `choice-${viewport.name}-open`)

    // Hold the send so the picked row shows its spinner, then let it through.
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route('**/*', async route => {
      const request = route.request()
      if (request.method() === 'POST' && request.headers()['next-action']) { await held; return route.continue() }
      return route.fallback()
    })
    await cloud.click()
    await expect(cloud.getByRole('status')).toBeVisible()
    await expect(second.getByRole('button', { name: /等它上线/ })).toBeDisabled()
    await shoot(page, testInfo, `choice-${viewport.name}-sending`)
    release()
    await expect(chat.getByText('在 Mikka Cloud 上运行', { exact: true }).last()).toBeVisible()
    await expect(cloud).toHaveAttribute('aria-pressed', 'true')
    await expect(cloud).toBeDisabled()
    await expect(second.getByRole('button', { name: /等它上线/ })).toBeDisabled()
    await expect(page.getByText(/个来源/)).toHaveCount(0)
    await page.unroute('**/*')
    await shoot(page, testInfo, `choice-${viewport.name}-picked`)
  })

  test(`dispatch-failure card without an E2B key leads to settings instead of answering (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const { email } = await register(page)
    const task = await seedTask(page, '首页加载提速')
    await seed(email, [{ role: 'user', content: '官网首页在手机上太慢了' }, { role: 'assistant', content: dispatchFailed(task, true) }])
    await page.goto(app('/?section=coordinator'))
    const card = page.getByRole('region', { name: 'Coordinator', exact: true }).getByRole('group', { name: /派不出去/ })
    const setup = card.getByRole('link', { name: /去设置 E2B 密钥/ })
    await expect(setup).toHaveAttribute('href', /\/settings\?section=secrets$/)
    // Without a key there is no run-on-cloud option: no button or link offers it (the question itself names Mikka Cloud).
    const runOnCloud = /Run on Mikka Cloud|在 Mikka Cloud 上运行/
    await expect(card.getByRole('button', { name: runOnCloud })).toHaveCount(0)
    await expect(card.getByRole('link', { name: runOnCloud })).toHaveCount(0)
    await expect(card.getByRole('button', { name: /等它上线/ })).toBeEnabled()
    await shoot(page, testInfo, `choice-${viewport.name}-nokey`)
    await setup.click()
    await expect(page).toHaveURL(/\/settings\?section=secrets/)
    await expect(page.getByRole('heading', { level: 1, name: '密钥与环境', exact: true })).toBeVisible()
  })

  test(`after answering, the no-key option is a record, not a settings link (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const { email } = await register(page)
    const task = await seedTask(page, '首页加载提速')
    await seed(email, [{ role: 'user', content: '官网首页在手机上太慢了' }, { role: 'assistant', content: dispatchFailed(task, true) }, { role: 'user', content: '等它上线' }])
    await page.goto(app('/?section=coordinator'))
    const card = page.getByRole('region', { name: 'Coordinator', exact: true }).getByRole('group', { name: /派不出去/ })
    await expect(card.getByRole('button', { name: /等它上线/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(card.getByRole('link', { name: /去设置 E2B 密钥/ })).toHaveCount(0)
    await expect(card.getByText('去设置 E2B 密钥', { exact: true }).locator('xpath=ancestor::*[@data-slot="item"][1]')).toHaveAttribute('aria-disabled', 'true')
  })
}
