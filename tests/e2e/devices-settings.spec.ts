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
  const ids = { laptop: randomUUID(), server: randomUUID(), bare: randomUUID(), offline: randomUUID() }
  // A heartbeat in the future keeps a device online for the whole test.
  await db().query(`INSERT INTO devices (id, "ownerId", name, kind, enabled, "deviceType", "lastSeenAt", harnesses) VALUES
    ($1, $5, 'E2E MacBook', 'local', true, 'laptop', now() + interval '1 hour', $6),
    ($2, $5, 'build-01', 'local', true, 'server', now() + interval '1 hour', $7),
    ($3, $5, 'dev-vps', 'local', true, 'server', now() + interval '1 hour', '[]'),
    ($4, $5, 'gpu-box', 'local', false, 'server', now() - interval '3 days', '[]')`, [ids.laptop, ids.server, ids.bare, ids.offline, session.userId,
    JSON.stringify([{ harness: 'claude_code', installed: true, version: '1.0.0' }, { harness: 'codex', installed: true, version: '1.0.0' }]),
    JSON.stringify([{ harness: 'claude_code', installed: true, version: '1.0.0' }, { harness: 'cursor', installed: false, version: null }])])
  return { ...ids, userId: session.userId }
}

const row = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })

test('设备：本机与 Remote control 分组，Agent 图标，重命名、重新检测、移除', async ({ page }) => {
  await register(page, '/settings?section=devices')
  await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible()
  const ids = await seed(page)
  await page.reload()

  const local = page.getByRole('region', { name: '本机' })
  const remote = page.getByRole('region', { name: 'Remote control' })
  await expect(local.getByText('E2E MacBook', { exact: true })).toBeVisible()
  await expect(remote.getByText('build-01', { exact: true })).toBeVisible()
  await expect(page.getByText('这个分区还在设计中', { exact: false })).toHaveCount(0)

  // R-74: the reported agents are their marks, named for screen readers; uninstalled ones are not shown.
  await expect(row(page, 'E2E MacBook').getByRole('img', { name: 'Claude Code' })).toBeVisible()
  await expect(row(page, 'E2E MacBook').getByRole('img', { name: 'Codex' })).toBeVisible()
  await expect(row(page, 'build-01').getByRole('img', { name: 'Cursor' })).toHaveCount(0)
  await expect(row(page, 'dev-vps')).toContainText('未检测到 Agent')
  await row(page, 'dev-vps').getByRole('button', { name: '安装方法' }).click()
  await expect(page.getByText('npm install -g @openai/codex')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(row(page, 'gpu-box').getByRole('button', { name: '重新连接' })).toBeVisible()
  await expect(row(page, 'gpu-box').getByRole('switch', { name: '允许调度到 gpu-box' })).not.toBeChecked()

  await row(page, 'build-01').getByRole('button', { name: 'build-01 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '重新检测 Agent' }).click()
  await expect(page.getByText('已让 build-01 重新检测 Agent')).toBeVisible()
  await expect.poll(async () => (await db().query('SELECT kind FROM device_management_commands WHERE "deviceId" = $1', [ids.server])).rows.map(item => item.kind)).toEqual(['redetect'])

  await row(page, 'gpu-box').getByRole('button', { name: 'gpu-box 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '重启 daemon' }).click()
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
  await expect(page.getByRole('alertdialog', { name: '移除「dev-vps」？' })).toBeVisible()
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
        hosts: async () => ['build-01', 'build-02', 'staging'],
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
  await dialog.getByRole('option', { name: /build-02/ }).click()
  await dialog.getByRole('button', { name: '添加', exact: true }).click()

  await expect(dialog.getByRole('heading', { name: '信任「build-02」？' })).toBeVisible()
  await expect(dialog).toContainText('SHA256:Vq3rX0d1')
  await dialog.getByRole('button', { name: '信任并继续' }).click()

  await expect(dialog.getByRole('heading', { name: '添加「build-02」' })).toBeVisible()
  await expect(dialog).toContainText('npm 权限不足（EACCES）')
  await dialog.getByRole('button', { name: '重试' }).click()
  await expect(dialog.getByRole('listitem').filter({ hasText: '已上线' }).getByRole('img', { name: 'Claude Code' })).toBeVisible()
  await dialog.getByRole('button', { name: '完成' }).click()
  await expect(dialog).toBeHidden()
})
