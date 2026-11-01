import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, conversationPill, app } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Question card acceptance requires an isolated E2E_DATABASE_URL')
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

const start = '{id:"start", title:"请问您想先从什么开始？", options:[{value:"plan", label:"先列计划"}, {value:"draft", label:"直接写初稿"}]}'
// The blank step Alex hit: a title with nothing to answer with. Streamed replies are not schema-checked.
const blank = '{id:"confirm", title:"确认建议方案"}'
const tone = '{id:"tone", title:"语气要哪种？", multiple:true, allowCustom:true, options:[{value:"formal", label:"正式"}, {value:"casual", label:"轻松"}]}'
const reply = (questions: string) => `root = Stack([q])\nq = BeQuestions("写一份周报", [${questions}])`

async function openBot(page: import('@playwright/test').Page, content: string) {
  const { email } = await register(page)
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  await dialog.getByLabel('名字', { exact: true }).fill('写作助手')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(conversationPill(page)).toHaveText('写作助手')
  const botId = new URL(page.url()).searchParams.get('bot')
  expect(botId).toMatch(/^[0-9a-f-]{36}$/)
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    for (const [index, message] of [{ role: 'user', content: '帮我写一份周报' }, { role: 'assistant', content }].entries()) {
      await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), user.id, botId, index + 1, JSON.stringify(message)])
    }
  } finally { await pool.end() }
  await page.goto(app(`/?bot=${botId}`))
  return page.getByRole('region', { name: '与 写作助手 的对话', exact: true })
}

test('one real question (the blank step dropped) answers on the first click', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const chat = await openBot(page, reply(`${start}, ${blank}`))
  const card = chat.getByRole('group', { name: '请问您想先从什么开始？' })
  await expect(card).toBeVisible()
  await expect(chat.getByText('确认建议方案')).toHaveCount(0)
  await expect(chat.getByRole('button', { name: '提交回答并继续' })).toHaveCount(0)
  await card.getByRole('button', { name: /先列计划/ }).click()
  await expect(chat.getByText('先列计划', { exact: true }).last()).toBeVisible()
  await expect(card.getByRole('button', { name: /先列计划/ })).toHaveAttribute('aria-pressed', 'true')
  await shoot(page, testInfo, 'question-single')
})

test('several questions: a single choice moves on by itself, and the last step submits', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const chat = await openBot(page, reply(`${start}, ${blank}, ${tone}`))
  // The step is the dots beside the buttons, read out as 「第1 题，共2 题」; no 「1/2」 by the title (R-40).
  await expect(chat.getByText('第1 题，共2 题', { exact: true })).toBeAttached()
  await expect(chat.getByText('1/2', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('给 写作助手 发消息', { exact: true })).toBeVisible()
  await shoot(page, testInfo, 'question-step-1')

  await chat.getByRole('radio', { name: '直接写初稿' }).click()
  // No 下一题 press: the next question opens on its own, and it is never the blank step.
  await expect(chat.getByRole('heading', { name: '语气要哪种？' })).toBeVisible()
  await expect(chat.getByText('第2 题，共2 题', { exact: true })).toBeAttached()
  await expect(chat.getByText('确认建议方案')).toHaveCount(0)

  const submit = chat.getByRole('button', { name: '提交回答并继续' })
  await expect(submit).toBeDisabled()
  await chat.getByRole('checkbox', { name: '正式' }).click()
  await chat.getByLabel('语气要哪种？：补充回答', { exact: true }).fill('少用术语')
  await expect(submit).toBeEnabled()
  await shoot(page, testInfo, 'question-step-2')

  await submit.click()
  await expect(chat.getByText('回答已提交给 Bot。', { exact: false })).toBeVisible()
  await expect(chat.getByText(/语气要哪种？：正式；少用术语/).first()).toBeVisible()
  await shoot(page, testInfo, 'question-submitted')
})
