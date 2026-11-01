import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'

// The app is served under next.config.mjs's basePath. page.goto('/x') resolves
// against the origin, so app paths go through app().
export const BASE_PATH = '/mikka'
export function app(path: string) {
  if (path === '/' || path.startsWith('/?')) return `${BASE_PATH}${path.slice(1)}`
  return `${BASE_PATH}${path}`
}

/** Buttons on the left icon rail (主页 / 建议 / 看板 / 插件 / Artifact). Phones have no rail. */
export function rail(page: Page, name: '主页' | '建议' | '看板' | '插件' | 'Artifact') {
  return page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name, exact: true })
}

/** Opens ⌘K from the top bar; returns the dialog. */
export async function openSearch(page: Page) {
  // Desktop uses the top bar; phones keep the search icon in the page header.
  await page.getByRole('button', { name: /^(打开)?全局搜索$/ }).click()
  const dialog = page.getByRole('dialog', { name: '全局搜索', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Searches ⌘K for a task by title and opens it. */
export async function openIssueFromSearch(page: Page, title: string) {
  const dialog = await openSearch(page)
  await dialog.getByRole('combobox', { name: '全局搜索', exact: true }).fill(title)
  await dialog.getByRole('option').filter({ hasText: title }).click()
}

/** ⌘K's 新建任务 opens the dialog that hands a sentence to the Coordinator. */
export async function openCreateIssue(page: Page) {
  const dialog = await openSearch(page)
  await dialog.getByRole('option', { name: '新建任务', exact: true }).click()
  const create = page.getByRole('dialog', { name: '新建任务', exact: true })
  await expect(create).toBeVisible()
  // ⌘K search plays its close animation before unmounting; wait until it has gone.
  await expect(page.getByRole('dialog')).toHaveCount(1)
  return create
}

let pool: Pool | null = null
function database() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('E2E 任务数据必须写入独立的 E2E_DATABASE_URL。')
  return pool ??= new Pool({ connectionString, max: 1 })
}

/**
 * Unrelated browser tests seed tasks directly to stay focused. The separate
 * tests/mvp suite runs the actual Coordinator workflow and must not use this.
 */
export async function seedTask(page: Page, title: string, { status = 'todo', priority = 'normal', parentId }: { status?: string; priority?: string; parentId?: string } = {}) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedTask 需要已登录的页面。')
  const db = database()
  const { rows: [session] } = await db.query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  if (!session) throw new Error('找不到当前登录会话。')
  const { rows: [{ number }] } = await db.query<{ number: number }>(`SELECT COALESCE(MAX((content->'attrs'->'mikka'->>'number')::int), 0) + 1 AS number FROM issues WHERE "userId" = $1`, [session.userId])
  const id = randomUUID()
  const content = { type: 'doc', content: [{ type: 'paragraph' }], attrs: { mikka: parentId ? { number, parentId } : { number } } }
  await db.query('INSERT INTO issues (id, "userId", title, content, status, priority) VALUES ($1, $2, $3, $4, $5, $6)', [id, session.userId, title, content, status, priority])
  await db.query('INSERT INTO issue_versions (id, "issueId", "userId", revision, title, content, status, priority) VALUES ($1, $2, $3, 1, $4, $5, $6, $7)', [randomUUID(), id, session.userId, title, content, status, priority])
  return id
}

/** A shown 建议 item for the signed-in person. */
export async function seedSuggestion(page: Page, { source = 'gmail', action = 'reply', title, actionTitle = null }: { source?: string; action?: string; title: string; actionTitle?: string | null }) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedSuggestion 需要已登录的页面。')
  const db = database()
  const { rows: [session] } = await db.query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  if (!session) throw new Error('找不到当前登录会话。')
  const id = randomUUID()
  await db.query('INSERT INTO suggestions (id, "userId", source, "externalId", action, title, shown, "decidedBy", "actionTitle", "occurredAt") VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, now())', [id, session.userId, source, `e2e-${id}`, action, title, 'rule', actionTitle])
  return id
}

/** The Coordinator's last turn failed with `error`, as a refused hosted-model call leaves it. */
export async function seedCoordinatorError(page: Page, error: string) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedCoordinatorError 需要已登录的页面。')
  const db = database()
  const { rows: [session] } = await db.query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  if (!session) throw new Error('找不到当前登录会话。')
  await db.query('INSERT INTO coordinator_sessions ("userId", "botId", "lastError", "lastErrorAt") VALUES ($1, NULL, $2, now()) ON CONFLICT ON CONSTRAINT coordinator_sessions_chat_key DO UPDATE SET "lastError" = $2, "lastErrorAt" = now()', [session.userId, error])
}

/** The signed-in person's workspace has a verified card and `remaining` microdollars of Mikka 默认 allowance (#523, #525). */
export async function seedHostedVerification(page: Page, remaining: number) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedHostedVerification 需要已登录的页面。')
  const db = database()
  const { rows: [member] } = await db.query<{ workspaceId: string }>('SELECT m."workspaceId" FROM session s JOIN mikka_workspace_members m ON m."userId" = s."userId" WHERE s.token = $1 LIMIT 1', [decodeURIComponent(cookie.value).split('.')[0]])
  if (!member) throw new Error('找不到当前登录会话的工作区。')
  await db.query('INSERT INTO hosted_verifications ("workspaceId") VALUES ($1) ON CONFLICT DO NOTHING', [member.workspaceId])
  await db.query('INSERT INTO hosted_allowances ("workspaceId", remaining) VALUES ($1, $2) ON CONFLICT ("workspaceId") DO UPDATE SET remaining = $2', [member.workspaceId, remaining])
}

/** A team workspace the signed-in person administers, beside their personal one (decision 2026-10-31-2130). */
export async function seedTeamWorkspace(page: Page, name = 'E2E 团队') {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedTeamWorkspace 需要已登录的页面。')
  const db = database()
  const { rows: [user] } = await db.query<{ id: string; name: string; email: string }>('SELECT u.id,u.name,u.email FROM session s JOIN "user" u ON u.id = s."userId" WHERE s.token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  if (!user) throw new Error('找不到当前登录会话。')
  const id = randomUUID()
  await db.query(`INSERT INTO mikka_workspaces (id, "userId", name, kind) VALUES ($1, $2, $3, 'team')`, [id, user.id, name])
  await db.query(`INSERT INTO mikka_workspace_members ("workspaceId", "userId", name, email, role) VALUES ($1, $2, $3, $4, 'admin')`, [id, user.id, user.name, user.email.toLowerCase()])
  return id
}

/** The current conversation's title pill over the chat (desktop). */
export function conversationPill(page: Page) {
  // Conversations opened earlier stay mounted but hidden; only the current one is visible.
  return page.locator('[data-slot="conversation-pill"]:visible [data-slot="conversation-pill-title"]')
}

// The composer is server-rendered. Text typed before React hydrates it can be
// reset to the controlled (empty) value, which no person could do in practice
// and made the composer tests flaky. Type only once React owns the field.
export async function hydrated(field: Locator) {
  await expect.poll(() => field.evaluate(element => Object.keys(element).some(key => key.startsWith('__reactProps$')))).toBe(true)
}

/**
 * Each text appears exactly once among the items, in any order and next to any
 * other items. Use it instead of an ordered toHaveText([...]) list, which fails
 * whenever an unrelated item is added or the order changes.
 */
export async function expectItems(items: Locator, texts: string[]) {
  for (const text of texts) {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const exact = new RegExp('^\\s*' + escaped + '\\s*$')
    await expect(items.filter({ hasText: exact }), text).toHaveCount(1)
  }
}

/**
 * API-only specs sign up through the browser, then work over HTTP and SQL. Leave
 * the signed-in page before seeding: an open workspace page can reload and take
 * row locks on the same issues while a fixture transaction holds them (a
 * deadlock that surfaced as HTTP 500 on /mikka). page.request keeps the session.
 */
export async function leavePage(page: Page) {
  await page.goto('about:blank')
}

type ExpectedConsoleError = { path: string; message: string }

/**
 * expectedConsoleErrors: each entry absorbs exactly one matching console error.
 * allowedConsoleErrors: a per-test allowlist for denials the test provokes on
 * purpose (for example a 403 on a workspace it may not read). Each entry absorbs
 * any number of matching errors, so a refetch does not fail the guard; anything
 * else, every page error and every same-origin 5xx still fails the test.
 */
export function watchRuntime(context: BrowserContext, expectedConsoleErrors: ExpectedConsoleError[] = [], allowedConsoleErrors: ExpectedConsoleError[] = []) {
  const failures: string[] = []
  const expected = [...expectedConsoleErrors]
  context.on('page', page => {
    page.on('pageerror', error => failures.push(error.stack ?? error.message))
    page.on('console', message => {
      if (message.type() !== 'error') return
      const matches = (error: ExpectedConsoleError) => message.text() === error.message && message.location().url === `${new URL(page.url()).origin}${error.path}`
      const index = expected.findIndex(matches)
      if (index >= 0) expected.splice(index, 1)
      else if (!allowedConsoleErrors.some(matches)) failures.push(`console.error: ${message.text()}`)
    })
    page.on('response', response => {
      if (response.status() >= 500 && new URL(response.url()).origin === new URL(page.url()).origin) {
        failures.push(`HTTP ${response.status()}: ${response.url()}`)
      }
    })
  })
  return failures
}

export function browserClientHeaders() {
  // 独立测试客户端使用基准测试保留网段，避免共享 CI 来源耗尽生产限流；不修改应用限流规则。
  return { 'x-forwarded-for': `198.18.${randomInt(256)}.${randomInt(1, 255)}` }
}

export const test = base.extend<{ runtimeGuard: void; expectedConsoleErrors: ExpectedConsoleError[]; allowedConsoleErrors: ExpectedConsoleError[] }>({
  expectedConsoleErrors: [[], { option: true }],
  allowedConsoleErrors: [[], { option: true }],
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, ...browserClientHeaders() })
  },
  runtimeGuard: [async ({ context, expectedConsoleErrors, allowedConsoleErrors }, use, testInfo) => {
    const failures = watchRuntime(context, expectedConsoleErrors, allowedConsoleErrors)
    await use()
    if (failures.length) await testInfo.attach('runtime-errors', { body: failures.join('\n\n'), contentType: 'text/plain' })
    expect(failures, '页面异常、console.error 或服务端 5xx 不得被忽略').toEqual([])
  }, { auto: true }],
})
export { expect }

export async function fillSecretPassword(page: Page, password: string) {
  if (process.env.MIKKA_TEST_ENVIRONMENT_FILE) await recordAuthenticationSecrets([password])
  const input = page.getByLabel('密码', { exact: true })
  await input.focus()
  // Playwright exports fill(value) in HTML step titles even with traces off.
  // Evaluate has no rendered argument params; preserve the real form and its
  // normal input/change events without exporting the generated password.
  await input.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'password') throw new Error('PASSWORD_INPUT_UNAVAILABLE')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('PASSWORD_INPUT_UNAVAILABLE')
    setter.call(element, value)
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, password)
}

export async function captureAuthenticationCookies(context: BrowserContext) {
  if (!process.env.MIKKA_TEST_ENVIRONMENT_FILE) return
  await recordAuthenticationSecrets((await context.cookies()).flatMap(cookie => {
    const decoded = decodeURIComponent(cookie.value)
    return [cookie.value, decoded,
      ...(cookie.name.endsWith('session_token') ? [decoded.split('.')[0]] : []),
      ...(cookie.name.includes('_multi-') ? [cookie.name] : []),
    ]
  }))
}

/**
 * A new account opens on the first-run guide, which only the workspace root
 * shows. Tests about other flows mark it done and skip it in place, without a
 * reload that would refetch the page's data; tests/e2e/onboarding.spec.ts
 * covers the guide.
 */
export async function skipOnboarding(page: Page, email: string) {
  await database().query('insert into user_onboarding ("userId") select id from "user" where email = $1 on conflict do nothing', [email])
  if (new URL(page.url()).pathname.replace(/\/$/, '') !== app('/').replace(/\/$/, '')) return
  const guide = page.getByRole('dialog', { name: '创建你的第一个 Bot', exact: true })
  await guide.getByRole('button', { name: '跳过引导', exact: true }).click()
  await expect(guide).toHaveCount(0)
}

/**
 * register(), then a team workspace the new person administers, selected as the current one.
 * A new account's own workspace is personal and has no members, 团队权限 or 审计日志 (decision 2026-10-31-2130).
 */
export async function registerInTeam(page: Page, next = '/', email?: string, options: { onboarding?: boolean } = {}) {
  const account = await register(page, '/', email, options)
  const workspaceId = await seedTeamWorkspace(page)
  await page.context().addCookies([{ name: 'mikka-workspace', value: workspaceId, url: new URL(page.url()).origin }])
  await page.goto(app(next))
  return { ...account, workspaceId }
}

export async function register(page: Page, next = '/', email = `e2e-${randomUUID()}@example.com`, { onboarding = false } = {}) {
  const password = randomBytes(32).toString('base64url')
  try {
    await page.goto(app(`/sign-up?next=${encodeURIComponent(next)}`))
    await page.getByLabel('称呼', { exact: true }).fill('回归测试成员')
    await page.getByLabel('邮箱', { exact: true }).fill(email)
    await fillSecretPassword(page, password)
    // Better Auth 的生产规则为同一来源每 10 秒最多注册 3 次；CI 所有浏览器共享来源。
    await delay(4000)
    await page.getByRole('button', { name: '创建账号并进入', exact: true }).click()
    await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === app(next))
    if (!onboarding) await skipOnboarding(page, email)
    return { email, password }
  } finally {
    // Existing real signup tests also feed the private artifact scanner. A
    // failed form submit must not leave its generated password unaccounted for.
    await captureAuthenticationCookies(page.context())
  }
}
