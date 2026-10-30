import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type { Page, Route } from '@playwright/test'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

// A3: the acceptance window's evidence viewer over run captures (Figma
// 357:4750 frames 06, 12, 13, 14, 15). Server responses are fixtures; the
// capture route's authorization is covered by
// lib/factory/evidence-media.test.ts and the approval DB test. Each state is
// shot in light and dark, desktop and phone, for design review.

/** A real PNG (solid tone with a darker band), so the image viewer decodes it. */
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const tone = y < height * 0.12 ? 228 : y > height * 0.3 && y < height * 0.62 && x % (width / 3) > 16 ? 214 : 248
    rows.fill(tone, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

async function shoot(page: Page, name: string) {
  for (const [suffix, size] of [['', { width: 1440, height: 960 }], ['-mobile', { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(150)
      await page.screenshot({ path: test.info().outputPath(`shots/a3-${name}${suffix}-${scheme}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
}

type Media = (route: Route, captureId: string) => Promise<void>
async function open(page: Page, artifacts: Record<string, unknown>[], media: Media) {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page)
  const title = `Factory A3 ${randomUUID()}`
  const issueId = await seedTask(page, title)
  const taskId = randomUUID(), candidateId = randomUUID()
  const binding = { taskId, issueId, attemptId: randomUUID(), revision: 1, candidateId }
  const candidate = { sha: 'a3f9c2e' + 'b'.repeat(33), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'home page' }
  await page.route('**/api/factory/tasks?issueId=*', route => route.fulfill({ json: { tasks: [{ id: taskId, issueId, stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId, candidateRunId: null, isSkillCandidate: false }] } }))
  await page.route(`**/api/factory/tasks/${taskId}/approval*`, route => {
    const url = new URL(route.request().url())
    if (url.searchParams.has('artifact')) return route.fulfill({ json: { raw: '$ pnpm e2e home-cls\n\nRunning 2 tests using 1 worker\n\n  ✓  1 home-cls.spec.ts:9:3 › 首屏 CLS < 0.1 (4.1 s)\n  ✓  2 home-cls.spec.ts:27:3 › 懒加载图片有固定宽高 (3.7 s)\n\n  2 passed (8.6 s)' } })
    if (url.searchParams.get('view') === 'ledger') return route.fulfill({ json: { binding, approvals: [], publications: [] } })
    return route.fulfill({ json: { binding, evidenceReadId: randomUUID(), evidenceDigest: 'b'.repeat(64), manifest: { candidate, artifacts } } })
  })
  const served: string[] = []
  await page.route(`**/api/factory/tasks/${taskId}/evidence/*`, route => {
    const captureId = new URL(route.request().url()).pathname.split('/').at(-1)!
    served.push(captureId)
    return media(route, captureId)
  })
  await openIssueFromSearch(page, title)
  await page.getByRole('button', { name: /Factory 验收/ }).click()
  const acceptance = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Factory 验收' }) })
  await expect(acceptance.getByRole('heading', { name: 'Factory 验收' })).toBeVisible()
  return { acceptance, served }
}

const base = { runId: randomUUID(), sessionId: 's1', candidateId: null, sha: null, environment: 'preview', recordedAt: '2026-10-28T06:20:00.000Z' }
const shot1 = randomUUID(), shot2 = randomUUID(), clip = randomUUID()
const manifest = [
  { ...base, stage: 'verify', kind: 'screenshot', artifact: `run-capture:${shot1}`, captureId: shot1, title: '首页首屏', contentType: 'image/png', size: 1, durationMs: null },
  { ...base, stage: 'verify', kind: 'screenshot', artifact: `run-capture:${shot2}`, captureId: shot2, title: '图片加载完成', contentType: 'image/png', size: 1, durationMs: null },
  { ...base, stage: 'verify', kind: 'video', artifact: `run-capture:${clip}`, captureId: clip, title: '向下滚动', contentType: 'video/mp4', size: 1, durationMs: 9000 },
  { ...base, stage: 'verify', kind: 'log', artifact: 'run-chunk:7d1c2a40-0000-4000-8000-000000000001' },
]
const image = png(1280, 800)
const serveImages: Media = (route, id) => id === clip ? route.fulfill({ status: 409, body: '' }) : route.fulfill({ status: 200, contentType: 'image/png', body: image })

test('evidence viewer: captures as thumbnails, image, recording error, text, keyboard and filmstrip', async ({ page }) => {
  const { acceptance, served } = await open(page, manifest, serveImages)
  const thumb = acceptance.getByRole('button', { name: '截图 · 首页首屏' })
  await expect(thumb).toBeVisible()
  await expect(acceptance.getByRole('button', { name: '录屏 · 向下滚动' })).toContainText('0:09')
  await expect(acceptance.getByRole('button', { name: /run-chunk:/ })).toBeVisible()
  await shoot(page, 'list')

  await thumb.click()
  const viewer = page.getByRole('dialog').filter({ has: page.getByTestId('evidence-counter') })
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('1 / 4')
  const shown = viewer.getByRole('img', { name: '首页首屏' })
  await expect(shown).toBeVisible()
  await expect.poll(() => shown.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1280)
  expect(served).toContain(shot1)
  await shoot(page, 'image')

  await page.keyboard.press('ArrowRight')
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('2 / 4')
  await expect(viewer.getByRole('img', { name: '图片加载完成' })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('3 / 4')
  // A capture the server refuses: error with retry.
  await expect(viewer.getByRole('alert')).toContainText('证据打开失败')
  await shoot(page, 'video-error')
  const before = served.filter(id => id === clip).length
  await viewer.getByRole('button', { name: '重试' }).click()
  await expect.poll(() => served.filter(id => id === clip).length).toBeGreaterThan(before)

  // The retry button leaves with the error, so move on from the filmstrip.
  await viewer.getByRole('group', { name: '全部证据' }).getByRole('button', { name: /run-chunk:/ }).click()
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('4 / 4')
  await expect(viewer.getByText('2 passed (8.6 s)')).toBeVisible()
  await expect(viewer.getByRole('button', { name: '下一条证据' })).toBeDisabled()
  await shoot(page, 'text')

  await viewer.getByRole('group', { name: '全部证据' }).getByRole('button', { name: '截图 · 图片加载完成' }).click()
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('2 / 4')
  await page.keyboard.press('Home')
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('1 / 4')
  await expect(viewer.getByRole('button', { name: '上一条证据' })).toBeDisabled()
  await expect(viewer.getByRole('link', { name: '下载' })).toHaveAttribute('href', new RegExp(`/api/factory/tasks/[^/]+/evidence/${shot1}$`))

  await viewer.getByRole('button', { name: '关闭证据' }).click()
  await expect(viewer).toHaveCount(0)
  await expect(acceptance.getByRole('heading', { name: 'Factory 验收' })).toBeVisible()
})

test('evidence viewer: media keeps a placeholder while it loads', async ({ page }) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { acceptance } = await open(page, manifest.slice(0, 1), async route => { await held; await route.fulfill({ status: 200, contentType: 'image/png', body: image }) })
  await acceptance.getByRole('button', { name: '截图 · 首页首屏' }).click()
  await expect(page.getByTestId('evidence-loading')).toBeVisible()
  await shoot(page, 'loading')
  release()
  await expect(page.getByTestId('evidence-loading')).toHaveCount(0)
})

test('evidence viewer: no evidence is one line', async ({ page }) => {
  const { acceptance } = await open(page, [], serveImages)
  await expect(acceptance.getByText('没有证据', { exact: true })).toBeVisible()
  await shoot(page, 'empty')
})
