import { randomUUID } from 'node:crypto'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// Installing the desktop app makes this computer a device (Alex, 2026-11-02,
// usability C10): once per launch the app installs or restarts its daemon in
// the background and 设置 › 设备 shows the progress; 添加设备 is SSH first with
// 手动连接 last, and 重新连接 on this computer restarts its daemon. Real
// application and PostgreSQL; only the desktop preload is stood in for, because
// the browser suite runs no Electron (main is covered by ssh-install.test.ts).
let pool: Pool | null = null
const db = () => pool ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
test.afterAll(async () => { await pool?.end() })

async function seed(page: Page, online: boolean) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('需要已登录的页面。')
  const { rows: [session] } = await db().query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  const mac = randomUUID()
  await db().query(`INSERT INTO devices (id, "ownerId", name, kind, enabled, "deviceType", "lastSeenAt", harnesses) VALUES ($1, $2, 'E2E Mac', 'local', true, 'laptop', now() ${online ? "+ interval '1 hour'" : "- interval '2 days'"}, $3)`,
    [mac, session.userId, JSON.stringify([{ harness: 'claude_code', installed: true, version: '1.0.0' }])])
  return mac
}

type Daemon = { status: 'online' | 'offline' | 'connecting'; deviceId: string | null; signedIn: boolean; server: 'online' | 'offline' | 'unregistered' | null }

/** The preload's ssh and device contract; the test emits each install state itself through window.emitSetup. */
async function stubDesktop(page: Page, daemon: Daemon) {
  await page.addInitScript(daemon => {
    const listeners = new Set<(state: unknown) => void>()
    const calls: string[] = []
    let current: unknown = null
    const w = window as unknown as { desktopCalls: string[]; emitSetup: (state: Record<string, unknown>) => void; mikka: unknown }
    w.desktopCalls = calls
    w.emitSetup = state => { current = state; listeners.forEach(listener => listener(state)) }
    const start = (target: string, step: string) => { current = { id: `${target}-${calls.length}`, target, step, status: 'running' }; return current }
    const noop = async () => {}
    w.mikka = {
      app: { runtime: 'electron', version: 'e2e', flavor: 'dev', serverUrl: location.origin, zeroUrl: location.origin, openExternal: noop, prepareAuth: noop },
      notifications: { setBadge: noop, show: noop, onClick: () => () => {}, consumePendingClick: async () => null },
      device: { status: async () => ({ ...daemon, workspaceId: null }) },
      ssh: {
        hosts: async () => [{ alias: 'build-01', user: 'alex', hostName: 'build-01', port: 22 }],
        state: async () => current,
        onChange: (listener: (state: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
        begin: async (target: string) => { calls.push(`begin:${target}`); return start(target, 'login') },
        accept: async () => null,
        cancel: async () => null,
        local: async () => { calls.push('local'); return start('this-computer', 'check') },
        restartLocal: async () => { calls.push('restartLocal'); return start('this-computer-reconnect', 'service') },
        autoLocal: async (action: string) => { calls.push(`autoLocal:${action}`); return start('this-computer', action === 'install' ? 'check' : 'service') },
      },
    }
  }, daemon)
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { desktopCalls: string[] }).desktopCalls)
const emit = (page: Page, state: Record<string, unknown>) => page.evaluate(state => (window as unknown as { emitSetup: (state: Record<string, unknown>) => void }).emitSetup(state), state)

async function shot(page: Page, target: Locator, testInfo: TestInfo, name: string) {
  await testInfo.attach(`${name}-light`, { body: await target.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await testInfo.attach(`${name}-dark`, { body: await target.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
}

async function open(page: Page, daemon: Daemon, online: boolean) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page, '/settings?section=devices')
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  const mac = await seed(page, online)
  await stubDesktop(page, typeof daemon.deviceId === 'string' && daemon.deviceId === 'SEEDED' ? { ...daemon, deviceId: mac } : daemon)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  return mac
}

const card = (page: Page) => page.getByRole('status').filter({ hasText: '这台电脑' })

test('首次启动：这台电脑还不是设备，App 在后台装好 daemon 并上线，设备页显示进度', async ({ page }, testInfo) => {
  const mac = await open(page, { status: 'offline', deviceId: null, signedIn: false, server: null }, true)
  await expect.poll(() => calls(page)).toEqual(['autoLocal:repair'])
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await emit(page, { id: 'auto', target: 'this-computer', step: 'install', status: 'running' })
  await expect(card(page)).toContainText('正在添加这台电脑')
  await expect(card(page)).toContainText('安装 Mikka 客户端')
  await shot(page, card(page), testInfo, 'local-installing')

  await emit(page, { id: 'auto', target: 'this-computer', step: 'connect', status: 'online', deviceId: mac })
  await expect(card(page)).toContainText('这台电脑已上线')
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Mac' })).toBeVisible()
  await shot(page, card(page), testInfo, 'local-online')
})

test('已经是本人的设备且在线：什么都不做', async ({ page }) => {
  await open(page, { status: 'online', deviceId: 'SEEDED', signedIn: true, server: 'online' }, true)
  await page.waitForLoadState('networkidle')
  expect(await calls(page)).toEqual([])
  await expect(card(page)).toHaveCount(0)
})

test('自动安装失败：显示原因和「重试」，重试后上线', async ({ page }, testInfo) => {
  const mac = await open(page, { status: 'online', deviceId: null, signedIn: false, server: 'unregistered' }, true)
  await expect.poll(() => calls(page)).toEqual(['autoLocal:install'])
  await emit(page, { id: 'auto', target: 'this-computer', step: 'install', status: 'failed', reason: 'npm ERR! code EACCES', retryable: true })
  await expect(card(page)).toContainText('无法添加这台电脑')
  await expect(card(page)).toContainText('npm ERR! code EACCES')
  await shot(page, card(page), testInfo, 'local-failed')

  await card(page).getByRole('button', { name: '重试' }).click()
  await expect.poll(() => calls(page)).toEqual(['autoLocal:install', 'local'])
  await emit(page, { id: 'retry', target: 'this-computer', step: 'connect', status: 'online', deviceId: mac })
  await expect(card(page)).toContainText('这台电脑已上线')
})

test('添加设备：没有「添加这台电脑」，先 SSH，最后是「手动连接」', async ({ page }, testInfo) => {
  await open(page, { status: 'online', deviceId: 'SEEDED', signedIn: true, server: 'online' }, true)
  await page.getByRole('button', { name: '添加设备' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('option', { name: /build-01/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /添加这台电脑/ })).toHaveCount(0)
  const manual = dialog.getByRole('button', { name: '手动连接' })
  expect((await dialog.getByRole('option', { name: /build-01/ }).boundingBox())!.y).toBeLessThan((await manual.boundingBox())!.y)
  await expect(dialog.getByText('mikka daemon login', { exact: false })).toHaveCount(0)
  await manual.click()
  await expect(manual).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByText('npm install --global', { exact: false })).toBeVisible()
  await expect(dialog.getByText('mikka daemon login', { exact: false })).toBeVisible()
  await shot(page, dialog, testInfo, 'add-device')
})

test('本机离线时「重新连接」直接重启本机 daemon，不打开 SSH', async ({ page }) => {
  await open(page, { status: 'online', deviceId: 'SEEDED', signedIn: true, server: 'offline' }, false)
  const row = page.getByRole('listitem').filter({ has: page.getByText('E2E Mac', { exact: true }) })
  await row.getByRole('button', { name: '重新连接' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '重新连接这台电脑', exact: true })).toBeVisible()
  await expect(dialog.getByRole('list', { name: '安装进度' }).getByRole('listitem')).toHaveText([/启动/, /已上线/])
  await expect(dialog.getByLabel('user@host:port')).toHaveCount(0)
  expect(await calls(page)).toEqual(['restartLocal'])
})
