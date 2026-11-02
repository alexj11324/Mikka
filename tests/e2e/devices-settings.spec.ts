import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// Real application, real PostgreSQL and the real server actions. Only the
// daemon's heartbeat (devices rows) is seeded, and in the second test the
// desktop preload's SSH bridge is stood in for, because the browser suite runs
// neither a daemon nor Electron. The real bridge is covered end to end by
// tests/ssh-install (#491).
let pool: Pool | null = null
const db = () => pool ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
test.afterAll(async () => { await pool?.end() })

async function seed(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('需要已登录的页面。')
  const { rows: [session] } = await db().query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  const ids = { laptop: randomUUID(), server: randomUUID(), bare: randomUUID(), offline: randomUUID(), blocked: randomUUID(), userns: randomUUID() }
  // A heartbeat in the future keeps a device online for the whole test.
  await db().query(`INSERT INTO devices (id, "ownerId", name, kind, enabled, "deviceType", "lastSeenAt", harnesses) VALUES
    ($1, $5, 'E2E MacBook', 'local', true, 'laptop', now() + interval '1 hour', $6),
    ($2, $5, 'build-01', 'local', true, 'server', now() + interval '1 hour', $7),
    ($3, $5, 'dev-vps', 'local', true, 'server', now() + interval '1 hour', '[]'),
    ($4, $5, 'gpu-box', 'local', false, 'server', now() - interval '3 days', '[]'),
    ($8, $5, 'no-sandbox', 'local', true, 'server', now() + interval '1 hour', $9),
    ($10, $5, 'ubuntu-2404', 'local', true, 'server', now() + interval '1 hour', $11)`, [ids.laptop, ids.server, ids.bare, ids.offline, session.userId,
    // The version lines the two CLIs print; the row shows the number only.
    JSON.stringify([{ harness: 'claude_code', installed: true, version: '2.1.3 (Claude Code)' }, { harness: 'codex', installed: true, version: 'codex-cli 0.46.0' }]),
    JSON.stringify([{ harness: 'claude_code', installed: true, version: '1.0.0' }, { harness: 'cursor', installed: false, version: null }]),
    ids.blocked,
    JSON.stringify([{ harness: 'claude_code', installed: false, version: '1.0.0', sandboxBlocked: { missing: ['socat', 'ripgrep'] } }]),
    ids.userns,
    // What a stock Ubuntu 24.04 daemon reports (bwrap's line from CI run 41313960870).
    JSON.stringify([{ harness: 'codex', installed: false, version: '1.0.0', sandboxBlocked: { missing: [], reason: 'userns_restricted', detail: 'sandbox probe failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' } }])])
  return { ...ids, userId: session.userId }
}

const row = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })

test('设备：本机与服务器分组，Agent 图标，重命名、重新检测、移除', async ({ page }) => {
  await register(page, '/settings?section=devices')
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  const ids = await seed(page)
  await page.reload()

  const local = page.getByRole('region', { name: '本机' })
  const remote = page.getByRole('region', { name: '服务器' })
  await expect(local.getByText('E2E MacBook', { exact: true })).toBeVisible()
  await expect(remote.getByText('build-01', { exact: true })).toBeVisible()
  await expect(page.getByText('这个分区还在设计中', { exact: false })).toHaveCount(0)

  // R-74: each reported agent shows its mark, name and version (settings evaluation D2); uninstalled ones are not shown.
  await expect(row(page, 'E2E MacBook')).toContainText(/Claude Code\s*2\.1\.3/)
  await expect(row(page, 'E2E MacBook')).toContainText(/Codex\s*0\.46\.0/)
  await expect(row(page, 'build-01')).not.toContainText('Cursor')
  // On a phone the switch keeps its label on a line of its own (D1).
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(row(page, 'E2E MacBook').getByText('参与调度', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(row(page, 'dev-vps')).toContainText('未检测到 Agent')
  await row(page, 'dev-vps').getByRole('button', { name: '安装方法' }).click()
  await expect(page.getByText('npm install -g @openai/codex')).toBeVisible()
  await page.keyboard.press('Escape')
  // A CLI the sandbox cannot run is named, never reported as absent.
  await expect(row(page, 'no-sandbox')).toContainText('已检测到 Claude Code，但沙箱不可用')
  await row(page, 'no-sandbox').getByRole('button', { name: '修复方法' }).click()
  await expect(page.getByText('这台设备无法自动安装 socat, ripgrep', { exact: false })).toBeVisible()
  await expect(page.getByText('user namespace 限制', { exact: false })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Ubuntu's AppArmor user namespace restriction: the commands that lift it, Ubuntu's spec, and the probe's own error.
  await row(page, 'ubuntu-2404').getByRole('button', { name: '修复方法' }).click()
  await expect(page.getByText('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0', { exact: true })).toBeVisible()
  await expect(page.getByText("echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/20-apparmor.conf", { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Ubuntu 对这项设置的说明' })).toHaveAttribute('href', /discourse\.ubuntu\.com\/t\/spec-unprivileged-user-namespace-restrictions/)
  await expect(page.getByText('错误：sandbox probe failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted')).toBeVisible()
  await expect(page.getByText('需要管理员开启 user namespace', { exact: false })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(row(page, 'gpu-box').getByRole('button', { name: '重新连接' })).toBeVisible()
  // Review C11: a device paired before only needs its client started again, not install and login.
  await row(page, 'gpu-box').getByRole('button', { name: '重新连接' }).click()
  const again = page.getByRole('dialog', { name: '重新连接', exact: true })
  await expect(again).toContainText('mikka daemon')
  await expect(again).not.toContainText('mikka daemon login')
  await expect(again).not.toContainText('npm install')
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await test.info().attach(`device-reconnect-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.keyboard.press('Escape')
  await expect(again).toHaveCount(0)
  // R5: an offline computer gets no runs; an online one with nothing allowed to run says so.
  await expect(row(page, 'gpu-box')).toContainText('离线 · 不会被派任务')
  await expect(row(page, 'E2E MacBook')).toContainText('不能跑允许使用的模型')
  // 参与调度 is each computer's one switch (decision 2026-11-02-1400); turning it off is saved and nothing else is offered.
  await expect(row(page, 'gpu-box').getByRole('switch', { name: 'gpu-box 参与调度' })).not.toBeChecked()
  await expect(row(page, 'build-01').getByRole('switch')).toHaveCount(1)
  const scheduling = row(page, 'E2E MacBook').getByRole('switch', { name: 'E2E MacBook 参与调度' })
  await expect(scheduling).toBeChecked()
  await scheduling.click()
  await expect(scheduling).not.toBeChecked()
  await expect.poll(async () => (await db().query('SELECT enabled FROM devices WHERE id = $1', [ids.laptop])).rows[0].enabled).toBe(false)

  await row(page, 'build-01').getByRole('button', { name: 'build-01 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '重新检测 Agent' }).click()
  await expect(page.getByText('已让 build-01 重新检测 Agent')).toBeVisible()
  await expect.poll(async () => (await db().query('SELECT kind FROM device_management_commands WHERE "deviceId" = $1', [ids.server])).rows.map(item => item.kind)).toEqual(['redetect'])

  await row(page, 'gpu-box').getByRole('button', { name: 'gpu-box 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '重启 Mikka 客户端' }).click()
  await expect(page.getByText('gpu-box 离线，上线后执行')).toBeVisible()

  await row(page, 'build-01').getByRole('button', { name: 'build-01 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await page.getByLabel('设备名称').fill('build-main')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(remote.getByText('build-main', { exact: true })).toBeVisible()
  await page.reload()
  await expect(remote.getByText('build-main', { exact: true })).toBeVisible()

  await row(page, 'dev-vps').getByRole('button', { name: 'dev-vps 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '移除设备' }).click()
  await expect(page.getByRole('alertdialog', { name: '移除「dev-vps」？' })).toContainText('也会卸载 dev-vps 上的 Mikka 客户端')
  await page.getByRole('button', { name: '移除', exact: true }).click()
  await expect(page.getByText('dev-vps', { exact: true })).toHaveCount(0)
  await expect.poll(async () => (await db().query('SELECT "removedAt" IS NOT NULL AS removed FROM devices WHERE id = $1', [ids.bare])).rows[0]?.removed).toBe(true)
})

test('设备（桌面版）：从 SSH 配置选主机，确认指纹，看安装进度，失败重试，上线', async ({ page }) => {
  await register(page, '/settings?section=devices')
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  const ids = await seed(page)
  // The preload's SSH contract (docs/backend/device-ssh-install.md), scripted: an
  // unknown host key first, then install fails once, then the retry comes online.
  await page.addInitScript(({ deviceId }) => {
    const listeners = new Set<(state: unknown) => void>()
    let attempt = 0
    const emit = (state: Record<string, unknown>) => { setTimeout(() => listeners.forEach(listener => listener(state)), 50); return state }
    const noop = async () => {}
    ;(window as unknown as { mikka: unknown }).mikka = {
      app: { runtime: 'electron', version: 'e2e', flavor: 'dev', serverUrl: location.origin, zeroUrl: location.origin, openExternal: noop, prepareAuth: noop },
      notifications: { setBadge: noop, show: noop, onClick: () => () => {}, consumePendingClick: async () => null },
      ssh: {
        // #540 shape: host details; the dialog also accepts bare aliases from older desktops.
        hosts: async () => [{ alias: 'build-01', user: 'alex', hostName: 'build-01', port: 22 }, { alias: 'build-02', user: 'alex', hostName: '10.0.4.12', port: 22 }, 'staging'],
        state: async () => null,
        onChange: (listener: (state: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
        begin: async (target: string) => {
          attempt += 1
          return attempt === 1
            ? { id: 'i1', target, step: 'login', status: 'fingerprint', fingerprint: 'ED25519 SHA256:Vq3rX0d1mKp8nF2sL7cTzY4wHj6eUaB9gR5oNiQxE0c' }
            : (emit({ id: 'i2', target, step: 'connect', status: 'online', deviceId }), { id: 'i2', target, step: 'install', status: 'running' })
        },
        accept: async (id: string) => {
          emit({ id, target: 'build-02', step: 'install', status: 'failed', reason: 'npm 权限不足（EACCES）', retryable: true })
          return { id, target: 'build-02', step: 'install', status: 'running' }
        },
      },
    }
  }, { deviceId: ids.server })
  await page.reload()

  await page.getByRole('button', { name: '添加设备' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('option', { name: /build-01/ })).toBeDisabled()
  await expect(dialog.getByRole('option', { name: /build-01/ })).toContainText('已添加')
  await expect(dialog.getByRole('option', { name: /build-02/ })).toContainText('alex@10.0.4.12')
  await dialog.getByRole('option', { name: /build-02/ }).click()
  await dialog.getByRole('button', { name: '添加', exact: true }).click()

  await expect(dialog.getByRole('heading', { name: '信任「build-02」？' })).toBeVisible()
  await expect(dialog).toContainText('SHA256:Vq3rX0d1')
  await dialog.getByRole('button', { name: '信任并继续' }).click()

  await expect(dialog.getByRole('heading', { name: '添加「build-02」' })).toBeVisible()
  await expect(dialog).toContainText('npm 权限不足（EACCES）')
  await dialog.getByRole('button', { name: '重试' }).click()
  await expect(dialog.getByRole('listitem').filter({ hasText: '已上线' })).toContainText('Claude Code')
  await dialog.getByRole('button', { name: '完成' }).click()
  await expect(dialog).toBeHidden()
})

// Review C6: until the list is read the page shows its shape, never 还没有设备.
test('设备：列表读到之前显示加载，读到空列表才说还没有设备', async ({ page }) => {
  await register(page, '/settings?section=devices')
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/*', async route => {
    if (route.request().method() === 'POST' && route.request().headers()['next-action']) await held
    await route.fallback()
  })
  try {
    await page.reload()
    await expect(page.getByRole('status', { name: '正在加载设备', exact: true })).toBeVisible()
    await expect(page.getByText('还没有设备', { exact: true })).toHaveCount(0)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await test.info().attach(`devices-loading-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
    }
    await page.emulateMedia({ colorScheme: 'light' })
  } finally { release() }
  await page.unroute('**/*')
  await expect(page.getByText('还没有设备', { exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: '正在加载设备', exact: true })).toHaveCount(0)
})
