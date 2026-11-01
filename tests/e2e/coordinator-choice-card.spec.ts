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

// What the bot draws from dispatch_run's machineUnavailable result (lib/rule-dispatch.ts machineUnavailableCard).
const needsMachine = 'root = Stack([q])\nq = BeQuestions("没有电脑能跑这个任务", [{id:"machine", title:"没有可用的电脑", description:"先连接或开启一台电脑，任务才能开始运行。", options:[{value:"computer", label:"在这台电脑上启用", action:"enableThisMac"}, {value:"e2b", label:"填入 E2B Key", action:"e2bKey"}, {value:"server", label:"连接我的服务器", action:"connectServer"}]}])'
const allowMachine = (deviceId: string) => `root = Stack([q])\nq = BeQuestions("没有电脑能跑这个任务", [{id:"machine", title:"没有可用的电脑", description:"先连接或开启一台电脑，任务才能开始运行。", options:[{value:"${deviceId}", label:"允许这台电脑自动调度", action:"allowAutoSchedule"}, {value:"e2b", label:"填入 E2B Key", action:"e2bKey"}, {value:"server", label:"让服务器重新上线", action:"serverOnline"}]}])`

// Dispatch option labels are English on purpose: the card localizes them by value.
// Visual and interaction coverage of stored replies; the Factory clarify answer itself is the person's next message.
async function seed(email: string, messages: object[]) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    for (const [index, message] of messages.entries()) await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, (SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $2), $3, $4)', [randomUUID(), user.id, index + 1, JSON.stringify(message)])
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
    // The E2B key is the person's own and lives under API 与订阅 (#745, CLOUD_KEY_SETTINGS).
    await expect(setup).toHaveAttribute('href', /\/settings\?section=models$/)
    // Without a key there is no run-on-cloud option: no button or link offers it (the question itself names Mikka Cloud).
    const runOnCloud = /Run on Mikka Cloud|在 Mikka Cloud 上运行/
    await expect(card.getByRole('button', { name: runOnCloud })).toHaveCount(0)
    await expect(card.getByRole('link', { name: runOnCloud })).toHaveCount(0)
    await expect(card.getByRole('button', { name: /等它上线/ })).toBeEnabled()
    await shoot(page, testInfo, `choice-${viewport.name}-nokey`)
    await setup.click()
    await expect(page).toHaveURL(/\/settings\?section=models/)
    await expect(page.getByRole('heading', { level: 1, name: 'API 与订阅', exact: true })).toBeVisible()
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

  test(`no machine: the card opens this computer's setup, the server settings and the E2B key dialog (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const { email } = await register(page)
    await seed(email, [{ role: 'user', content: '把首页压到 2 秒以内' }, { role: 'assistant', content: needsMachine }])
    await page.goto(app('/?section=coordinator'))
    const card = page.getByRole('region', { name: 'Coordinator', exact: true }).getByRole('group', { name: '没有可用的电脑' })
    await expect(card.getByRole('link', { name: /连接我的服务器/ })).toHaveAttribute('href', /\/settings\?section=computers$/)
    await expect(card.getByText('先连接或开启一台电脑，任务才能开始运行。')).toBeVisible()
    await shoot(page, testInfo, `machine-${viewport.name}-open`)
    // Rows open setup, they never answer: nothing is sent to the bot.
    await card.getByRole('button', { name: /在这台电脑上启用/ }).click()
    const mac = page.getByRole('dialog', { name: '添加设备' })
    await expect(mac).toBeVisible()
    await mac.getByRole('button', { name: '完成' }).click()
    await expect(mac).toHaveCount(0)
    await card.getByRole('button', { name: /填入 E2B Key/ }).click()
    await expect(page.getByRole('dialog', { name: 'E2B API Key' })).toBeVisible()
    await shoot(page, testInfo, `machine-${viewport.name}-e2b`)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'E2B API Key' })).toHaveCount(0)
    // Nothing was answered, so every row is still open.
    await expect(card.getByRole('button', { name: /填入 E2B Key/ })).toBeEnabled()
    await expect(card.getByRole('button', { name: /在这台电脑上启用/ })).toBeEnabled()
  })

  test(`no machine with a personal computer online: 允许这台电脑自动调度 switches it on and answers (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const { email } = await register(page)
    const pool = isolatedPool()
    const deviceId = randomUUID()
    try {
      const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt") VALUES ($1,$2,'MacBook','local','laptop',true,now())`, [deviceId, user.id])
    } finally { await pool.end() }
    await seed(email, [{ role: 'user', content: '把首页压到 2 秒以内' }, { role: 'assistant', content: allowMachine(deviceId) }])
    await page.goto(app('/?section=coordinator'))
    const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
    const card = chat.getByRole('group', { name: '没有可用的电脑' })
    await expect(card.getByRole('link', { name: /让服务器重新上线/ })).toHaveAttribute('href', /\/settings\?section=computers$/)
    const allow = card.getByRole('button', { name: /允许这台电脑自动调度/ })
    await allow.click()
    await expect(allow).toHaveAttribute('aria-pressed', 'true')
    await expect(chat.getByText('允许这台电脑自动调度', { exact: true }).last()).toBeVisible()
    const check = isolatedPool()
    try { expect((await check.query('SELECT "autoSchedule" FROM devices WHERE id=$1', [deviceId])).rows[0].autoSchedule).toBe(true) } finally { await check.end() }
  })
}
