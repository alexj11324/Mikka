import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// Usability C10: in the desktop app 添加设备 offers 添加这台电脑 first and SSH as
// 添加远程电脑; 重新连接 on this computer's own offline row restarts its daemon.
// Real application and PostgreSQL; only the desktop preload is stood in for,
// because the browser suite runs no Electron (main is covered by ssh-install.test.ts).
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

/** The preload's ssh and device contract, scripted: local() and restartLocal() step through to online. */
async function stubDesktop(page: Page, input: { thisDevice: string | null; onlineDevice: string }) {
  await page.addInitScript(({ thisDevice, onlineDevice }) => {
    const listeners = new Set<(state: unknown) => void>()
    const calls: string[] = []
    ;(window as unknown as { desktopCalls: string[] }).desktopCalls = calls
    const run = (target: string, steps: string[]) => {
      const id = `${target}-${calls.length}`
      steps.forEach((step, index) => setTimeout(() => listeners.forEach(listener => listener({ id, target, step, status: 'running' })), 150 * (index + 1)))
      setTimeout(() => listeners.forEach(listener => listener({ id, target, step: 'connect', status: 'online', deviceId: onlineDevice })), 150 * (steps.length + 2))
      return { id, target, step: steps[0], status: 'running' }
    }
    const noop = async () => {}
    ;(window as unknown as { mikka: unknown }).mikka = {
      app: { runtime: 'electron', version: 'e2e', flavor: 'dev', serverUrl: location.origin, zeroUrl: location.origin, openExternal: noop, prepareAuth: noop },
      notifications: { setBadge: noop, show: noop, onClick: () => () => {}, consumePendingClick: async () => null },
      device: { status: async () => ({ status: thisDevice ? 'offline' : 'offline', deviceId: thisDevice, workspaceId: null, signedIn: Boolean(thisDevice), server: null }) },
      ssh: {
        hosts: async () => [{ alias: 'build-01', user: 'alex', hostName: 'build-01', port: 22 }],
        state: async () => null,
        onChange: (listener: (state: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
        begin: async (target: string) => { calls.push(`begin:${target}`); return run(target, ['login', 'check', 'install', 'service']) },
        accept: async () => null,
        cancel: async () => null,
        local: async () => { calls.push('local'); return run('this-computer', ['check', 'install', 'service']) },
        restartLocal: async () => { calls.push('restartLocal'); return run('this-computer-reconnect', ['service']) },
      },
    }
  }, input)
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dialog = page.getByRole('dialog')
  await testInfo.attach(`${name}-light`, { body: await dialog.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await testInfo.attach(`${name}-dark`, { body: await dialog.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
}

test('桌面版添加设备：第一项是「添加这台电脑」，一键在本机装好并上线；SSH 在「添加远程电脑」下', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page, '/settings?section=devices')
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  const mac = await seed(page, true)
  await stubDesktop(page, { thisDevice: null, onlineDevice: mac })
  await page.reload()

  await page.getByRole('button', { name: '添加设备' }).click()
  const dialog = page.getByRole('dialog')
  const addThis = dialog.getByRole('button', { name: '添加这台电脑', exact: true })
  const remote = dialog.getByRole('heading', { name: '添加远程电脑', exact: true })
  await expect(addThis).toBeEnabled()
  await expect(remote).toBeVisible()
  // 添加这台电脑 comes before the SSH hosts.
  expect((await addThis.boundingBox())!.y).toBeLessThan((await remote.boundingBox())!.y)
  await expect(dialog.getByRole('option', { name: /build-01/ })).toBeVisible()
  await shot(page, testInfo, 'add-device')

  await addThis.click()
  await expect(dialog.getByRole('heading', { name: '添加这台电脑', exact: true })).toBeVisible()
  const steps = dialog.getByRole('list', { name: '安装进度' })
  await expect(steps.getByRole('listitem')).toHaveText([/安装 Mikka 客户端/, /启动/, /已上线/])
  await expect(steps.getByRole('listitem').filter({ hasText: '已上线' })).toContainText('完成')
  await shot(page, testInfo, 'add-this-online')
  expect(await page.evaluate(() => (window as unknown as { desktopCalls: string[] }).desktopCalls)).toEqual(['local'])
  await dialog.getByRole('button', { name: '完成' }).click()
  await expect(dialog).toBeHidden()
})

test('桌面版：本机离线时「重新连接」直接重启本机 daemon，不打开 SSH', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page, '/settings?section=devices')
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  const mac = await seed(page, false)
  await stubDesktop(page, { thisDevice: mac, onlineDevice: mac })
  await page.reload()

  const row = page.getByRole('listitem').filter({ has: page.getByText('E2E Mac', { exact: true }) })
  await row.getByRole('button', { name: '重新连接' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '重新连接这台电脑', exact: true })).toBeVisible()
  await expect(dialog.getByRole('list', { name: '安装进度' }).getByRole('listitem')).toHaveText([/启动/, /已上线/])
  await expect(dialog.getByLabel('user@host:port')).toHaveCount(0)
  await expect(dialog.getByRole('listitem').filter({ hasText: '已上线' })).toContainText('完成')
  await shot(page, testInfo, 'reconnect-this')
  expect(await page.evaluate(() => (window as unknown as { desktopCalls: string[] }).desktopCalls)).toEqual(['restartLocal'])

  // 添加这台电脑 says 已添加 once this computer has a device.
  await dialog.getByRole('button', { name: '完成' }).click()
  await page.getByRole('button', { name: '添加设备' }).click()
  await expect(dialog.getByRole('button', { name: /添加这台电脑/ })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /添加这台电脑/ })).toContainText('已添加')
})
