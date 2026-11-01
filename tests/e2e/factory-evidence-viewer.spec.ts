import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type { Browser, Page, Route } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register, seedTask, openIssueFromSearch, app } from './fixtures'

// A3: acceptance on the thread that produced the candidate (Figma 357:4750,
// frame 06 and phone 365:12779) and the evidence viewer (frames 12, 13, 14).
// The thread is a real seeded run; Factory responses are fixtures. The capture
// route's authorization is covered by lib/factory/evidence-media.test.ts and
// the approval DB test. Each state is shot in light and dark, desktop and
// phone, for design review.

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

const THREAD = '首页加载提速'

/** The thread that produced the candidate: a finished run on the issue, in the isolated E2E database. */
async function seedThread(email: string, title: string) {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Acceptance on a thread requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID(), runId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Mikka Frontend'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, "startedAt", "finishedAt") VALUES ($1, $2, $3, $4, $5, $6, now(), now())', [runId, user.id, issue.id, agentId, 'succeeded', THREAD])
    await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: '首屏图片改成懒加载，字体做了子集。' })])
    return runId
  } finally {
    await pool.end()
  }
}

type Media = (route: Route, captureId: string) => Promise<void>
type Detail = { checks: unknown[]; delivery: unknown }
async function open(page: Page, artifacts: Record<string, unknown>[], media: Media, detail: (candidateId: string) => Detail, taskId = randomUUID()) {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Factory A3 ${randomUUID()}`
  const issueId = await seedTask(page, title)
  const runId = await seedThread(email, title)
  const candidateId = randomUUID()
  const binding = { taskId, issueId, attemptId: randomUUID(), revision: 1, candidateId }
  await page.route('**/api/factory/tasks?issueId=*', route => route.fulfill({ json: { tasks: [{ id: taskId, issueId, stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId, candidateRunId: runId, isSkillCandidate: false }] } }))
  await page.route(`**/api/factory/tasks/${taskId}`, route => route.fulfill({ json: detail(candidateId) }))
  await page.route(`**/api/factory/tasks/${taskId}/approval*`, route => {
    const url = new URL(route.request().url())
    if (url.searchParams.has('artifact')) return route.fulfill({ json: { raw: 'BASE_URL=https://mikka-8quhtq3c9-mikka-dev.vercel.app\n\n> playwright test e2e/home-cls.spec.ts --project=mobile-4g\n\nRunning 2 tests using 1 worker\n\n  ✓  1 home-cls.spec.ts:9:3 › 首屏 CLS < 0.1 (4.1 s)\n  ✓  2 home-cls.spec.ts:27:3 › 懒加载图片有固定宽高 (3.7 s)\n\n  2 passed (8.6 s)' } })
    if (url.searchParams.get('view') === 'ledger') return route.fulfill({ json: { binding, approvals: [], publications: [], capabilities: { reject: true } } })
    return route.fulfill({ json: { binding, evidenceDigest: 'b'.repeat(64), manifest: { candidate, artifacts } } })
  })
  const served: string[] = []
  await page.route(`**/api/factory/tasks/${taskId}/evidence/*`, route => {
    const captureId = new URL(route.request().url()).pathname.split('/').at(-1)!
    served.push(captureId)
    return media(route, captureId)
  })
  await openIssueFromSearch(page, title)
  await page.getByRole('button', { name: 'Factory 验收', exact: true }).click()
  const thread = page.getByRole('region', { name: THREAD, exact: true })
  await expect(thread.getByRole('tab', { name: '验收' })).toHaveAttribute('aria-selected', 'true')
  return { thread, served, candidateId }
}

const sha = 'a3f9c2e' + 'b'.repeat(33)
const candidate = { sha, repository: 'alexj11324/Mikka', environment: 'preview', scope: 'home page' }
const base = { runId: 'verify-run', sessionId: 's1', candidateId: null, sha: null, environment: 'preview', recordedAt: '2026-10-28T06:20:00.000Z' }
const shot1 = randomUUID(), shot2 = randomUUID(), shot3 = randomUUID(), clip = randomUUID()
const log = 'run-chunk:7d1c2a40-0000-4000-8000-000000000001'
const manifest = [
  { ...base, stage: 'verify', kind: 'screenshot', artifact: `run-capture:${shot1}`, captureId: shot1, title: '首页首屏', contentType: 'image/png', size: 1, durationMs: null },
  { ...base, stage: 'verify', kind: 'video', artifact: `run-capture:${clip}`, captureId: clip, title: '向下滚动', contentType: 'video/mp4', size: 1, durationMs: 9000 },
  { ...base, stage: 'verify', kind: 'log', artifact: log },
  { ...base, stage: 'verify', kind: 'screenshot', artifact: `run-capture:${shot2}`, captureId: shot2, title: '图片加载完成', contentType: 'image/png', size: 1, durationMs: null },
  { ...base, stage: 'verify', kind: 'screenshot', artifact: `run-capture:${shot3}`, captureId: shot3, title: 'Lighthouse 移动端', contentType: 'image/png', size: 1, durationMs: null },
]
const criteria = [
  // #541: the verify agent names the command that checked this criterion; it wins over the run's.
  { criterionId: 'k1', text: '首页 2 秒内可交互（4G）', passed: true, evidence: `run-capture:${shot1} run-capture:${clip} ${log}`, command: 'pnpm e2e home-cls', exitCode: 0 },
  { criterionId: 'k2', text: '首屏图片懒加载后无布局跳动', passed: true, evidence: `run-capture:${shot2}` },
  { criterionId: 'k3', text: 'Lighthouse 性能分 ≥ 90', passed: true, evidence: `run-capture:${shot3}` },
]
const figma = (candidateId: string): Detail => ({
  checks: [
    { attemptId: randomUUID(), stage: 'review', status: 'passed', candidateId, candidateSha: sha, runId: randomUUID(), independent: true, criteria: [], verify: null },
    { attemptId: randomUUID(), stage: 'verify', status: 'passed', candidateId, candidateSha: sha, runId: 'verify-run', independent: true, criteria, verify: { status: 'passed', command: 'pnpm verify', exitCode: 0 } },
  ],
  delivery: {
    candidateSha: sha, pullRequest: { url: 'https://github.com/alexj11324/Mikka/pull/418', state: 'open', title: 'perf(home): 首屏图片懒加载与字体子集' }, repository: 'alexj11324/Mikka', environment: 'device:mac',
    previewUrl: 'https://mikka-8quhtq3c9-mikka-dev.vercel.app', deploymentEnvironment: 'preview', previewDatabaseBranch: 'preview/mik-48', machine: { name: 'Alex 的 MacBook', kind: 'device' },
  },
})
const image = png(1280, 800)
const serveImages: Media = (route, id) => id === clip ? route.fulfill({ status: 409, body: '' }) : route.fulfill({ status: 200, contentType: 'image/png', body: image })

test.describe(() => {
  // The recording is refused on purpose: the browser logs its first load and the retry, nothing else.
  const viewerTask = randomUUID()
  const refused = app(`/api/factory/tasks/${viewerTask}/evidence/${clip}`)
  const conflict = 'Failed to load resource: the server responded with a status of 409 (Conflict)'
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture functions require destructured arguments.
  test.use({ expectedConsoleErrors: async ({}, use) => { await use([{ path: refused, message: conflict }, { path: `${refused}?attempt=1`, message: conflict }]) } })

test('验收 on the thread: criteria with their evidence, independent results, the viewer by criterion', async ({ page }) => {
  const { thread, served } = await open(page, manifest, serveImages, figma, viewerTask)
  await expect(thread.getByText('待你确认', { exact: true }).first()).toBeVisible()
  const card = thread.getByRole('region', { name: '候选版本' })
  await expect(card.getByRole('link', { name: '#418' })).toHaveAttribute('href', 'https://github.com/alexj11324/Mikka/pull/418')
  await expect(card.getByText('perf(home): 首屏图片懒加载与字体子集')).toBeVisible()
  await expect(card.getByText('mikka-8quhtq3c9-mikka-dev.vercel.app')).toBeVisible()
  await expect(card.getByText('Preview · Neon preview/mik-48', { exact: true })).toBeVisible()
  const list = thread.getByRole('region', { name: '验收标准' })
  await expect(list.getByText('3/3', { exact: true })).toBeVisible()
  const first = list.getByRole('listitem').filter({ hasText: '首页 2 秒内可交互（4G）' })
  await expect(first.getByText('通过', { exact: true })).toBeVisible()
  await expect(first.getByRole('button', { name: '录屏 · 向下滚动' })).toContainText('0:09')
  await expect(first.getByRole('button', { name: 'pnpm e2e home-cls' })).toContainText('exit 0')
  await expect(thread.getByText(/run-chunk:|run-capture:/)).toHaveCount(0)
  const results = thread.getByRole('region', { name: '独立结果' })
  await expect(results.getByText('建议合并', { exact: true })).toBeVisible()
  await expect(results.getByRole('listitem').filter({ hasText: '验证' }).getByText('3/3', { exact: true })).toBeVisible()
  await expect(thread.getByRole('button', { name: '验收并合并' })).toBeVisible()
  await expect(thread.getByRole('button', { name: '退回修改' })).toBeVisible()
  await expect(thread.getByText(/有效/)).toHaveCount(0)
  await shoot(page, 'list')

  // 对话 shows the thread itself; 验收 comes back with the same content.
  await thread.getByRole('tab', { name: '对话' }).click()
  await expect(thread.getByText('首屏图片改成懒加载，字体做了子集。')).toBeVisible()
  await thread.getByRole('tab', { name: '验收' }).click()

  await first.getByRole('button', { name: '截图 · 首页首屏' }).click()
  const viewer = page.getByRole('dialog').filter({ has: page.getByTestId('evidence-counter') })
  await expect(viewer.getByRole('heading', { name: '首页 2 秒内可交互（4G）' })).toBeVisible()
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('1 / 3')
  const shown = viewer.getByRole('img', { name: '首页首屏' })
  await expect(shown).toBeVisible()
  await expect.poll(() => shown.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1280)
  expect(served).toContain(shot1)
  await shoot(page, 'image')

  await page.keyboard.press('ArrowRight')
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('2 / 3')
  // A capture the server refuses: error with retry.
  await expect(viewer.getByRole('alert')).toContainText('证据打开失败')
  await shoot(page, 'video-error')
  const before = served.filter(id => id === clip).length
  await viewer.getByRole('button', { name: '重试' }).click()
  await expect.poll(() => served.filter(id => id === clip).length).toBeGreaterThan(before)

  // The retry button leaves with the error, so move on from the filmstrip.
  await viewer.getByRole('group', { name: '全部证据' }).getByRole('button', { name: 'pnpm e2e home-cls' }).click()
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('3 / 3')
  await expect(viewer.getByText('$ pnpm e2e home-cls').first()).toBeVisible()
  await expect(viewer.getByText('2 passed (8.6 s)')).toBeVisible()
  await expect(viewer.getByRole('button', { name: '下一条证据' })).toBeDisabled()
  await shoot(page, 'text')

  await page.keyboard.press('Home')
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('1 / 3')
  await expect(viewer.getByRole('button', { name: '上一条证据' })).toBeDisabled()
  await expect(viewer.getByRole('link', { name: '下载' })).toHaveAttribute('href', new RegExp(`/api/factory/tasks/[^/]+/evidence/${shot1}$`))

  await viewer.getByRole('button', { name: '关闭证据' }).click()
  await expect(viewer).toHaveCount(0)
  await expect(list).toBeVisible()
})
})

/** A real two-second VP8 recording of a scrolling page, made by the browser itself (no ffmpeg on the runner). */
async function webm(browser: Browser) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.setContent('<canvas width="1280" height="720"></canvas>')
    const bytes = await page.evaluate(async () => {
      const canvas = document.querySelector('canvas')!
      const draw = canvas.getContext('2d')!
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' })
      const parts: Blob[] = []
      recorder.ondataavailable = event => parts.push(event.data)
      const stopped = new Promise(resolve => { recorder.onstop = resolve })
      recorder.start()
      const started = performance.now()
      await new Promise<void>(resolve => {
        const frame = () => {
          const offset = Math.min(1, (performance.now() - started) / 2000) * 360
          draw.fillStyle = '#f7f7f7'; draw.fillRect(0, 0, 1280, 720)
          draw.fillStyle = '#e4e4e4'; draw.fillRect(0, 0, 1280, 64)
          for (let row = 0; row < 6; row++) for (let column = 0; column < 3; column++) {
            draw.fillStyle = '#d6d6d6'; draw.fillRect(96 + column * 376, 112 + row * 240 - offset, 336, 200)
          }
          if (performance.now() - started < 2000) requestAnimationFrame(frame); else resolve()
        }
        frame()
      })
      recorder.stop()
      await stopped
      return Array.from(new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()))
    })
    return Buffer.from(bytes)
  } finally {
    await context.close()
  }
}

test('evidence viewer: a recording plays in the viewer', async ({ page, browser }) => {
  const recording = await webm(browser)
  const steps = [{ atMs: 0, label: '打开首页（4G）' }, { atMs: 600, label: '首屏出现' }, { atMs: 1200, label: '向下滚动' }]
  const clipManifest = manifest.map(entry => 'captureId' in entry && entry.captureId === clip ? { ...entry, contentType: 'video/webm', steps } : entry)
  const { thread } = await open(page, clipManifest, (route, id) => id === clip ? route.fulfill({ status: 200, contentType: 'video/webm', body: recording }) : route.fulfill({ status: 200, contentType: 'image/png', body: image }), figma)
  await thread.getByRole('button', { name: '录屏 · 向下滚动' }).click()
  const viewer = page.getByRole('dialog').filter({ has: page.getByTestId('evidence-counter') })
  await expect(viewer.getByTestId('evidence-counter')).toHaveText('2 / 3')
  const video = viewer.locator('video')
  await expect(video).toHaveAttribute('aria-label', '向下滚动')
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).videoWidth)).toBe(1280)
  await expect(viewer.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('evidence-loading')).toHaveCount(0)
  // The first frame is decoded, so the shot shows the recording rather than a blank player.
  await video.evaluate(async node => { const v = node as HTMLVideoElement; v.muted = true; await v.play(); v.pause() })
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBe(4)
  // Figma 13 「操作」: each step is its time and what was done; a step seeks the video.
  const timeline = viewer.getByRole('region', { name: '操作 3' })
  await expect(timeline.getByRole('listitem')).toHaveText([/0:00\.0\s*打开首页（4G）/, /0:00\.6\s*首屏出现/, /0:01\s*向下滚动/])
  await expect(timeline.getByText(/run-|click|mcp__/)).toHaveCount(0)
  // A browser-made WebM has no seek index (real recordings are ffmpeg MP4 with byte ranges), so record the seek the step asks for.
  await video.evaluate(node => {
    const v = node as HTMLVideoElement & { requestedSeek?: number }
    const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!
    Object.defineProperty(v, 'currentTime', { configurable: true, get: () => native.get!.call(v), set: (value: number) => { v.requestedSeek = value; native.set!.call(v, value) } })
  })
  await timeline.getByRole('button', { name: /向下滚动/ }).click()
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement & { requestedSeek?: number }).requestedSeek)).toBe(1.2)
  await expect(timeline.getByRole('button', { name: /向下滚动/ })).toHaveAttribute('aria-current', 'true')
  await shoot(page, 'video')
})

test('evidence viewer: media keeps a placeholder while it loads', async ({ page }) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { thread } = await open(page, manifest.slice(0, 1), async route => { await held; await route.fulfill({ status: 200, contentType: 'image/png', body: image }) }, figma)
  await thread.getByRole('button', { name: '截图 · 首页首屏' }).click()
  await expect(page.getByTestId('evidence-loading')).toBeVisible()
  await shoot(page, 'loading')
  release()
  await expect(page.getByTestId('evidence-loading')).toHaveCount(0)
})

test('no evidence and no checks is one line', async ({ page }) => {
  const { thread } = await open(page, [], serveImages, () => ({ checks: [], delivery: { candidateSha: sha, pullRequest: null, repository: 'alexj11324/Mikka', environment: null, previewUrl: null, deploymentEnvironment: null } }))
  await expect(thread.getByText('没有证据', { exact: true })).toBeVisible()
  await shoot(page, 'empty')
})

// #528 merge states on the thread, with the full Figma 06 evidence. GitHub's refusal is a 409 on purpose; the browser logs it once.
const mergeTask = randomUUID()
test.describe('merge states', () => {
  test.use({ expectedConsoleErrors: [{ path: app(`/api/factory/tasks/${mergeTask}/approval`), message: 'Failed to load resource: the server responded with a status of 409 (Conflict)' }] })
  test('无法合并 names GitHub\'s reason in the bar; 已合并 keeps the evidence and opens the PR', async ({ page }) => {
    const { thread, candidateId } = await open(page, manifest, serveImages, figma, mergeTask)
    const pr = 'https://github.com/alexj11324/Mikka/pull/418'
    // As the server records it: a refused attempt is a failed merge row, a merge marks the PR merged.
    let merge: Record<string, unknown> | null = null
    await page.route(`**/api/factory/tasks/${mergeTask}/approval*`, route => {
      const request = route.request()
      if (request.method() === 'POST') {
        merge = { id: randomUUID(), candidateId, status: 'failed', source: 'mikka', code: 'githubMergeBlocked', pullRequestUrl: pr, createdAt: new Date().toISOString() }
        return route.fulfill({ status: 409, json: { error: 'githubMergeBlocked', pullRequestUrl: pr } })
      }
      if (merge && new URL(request.url()).searchParams.get('view') === 'ledger')
        return route.fulfill({ json: { binding: {}, approvals: [], publications: [], merges: [merge], capabilities: { reject: true } } })
      return route.fallback()
    })
    await page.route(`**/api/factory/tasks/${mergeTask}`, route => {
      const body = figma(candidateId) as { delivery: Record<string, unknown> }
      if (merge?.status === 'merged') body.delivery = { ...body.delivery, pullRequest: { url: pr, state: 'merged' } }
      return route.fulfill({ json: body })
    })
    await thread.getByRole('button', { name: '验收并合并' }).click()
    await expect(thread.getByText('无法合并', { exact: true }).first()).toBeVisible()
    await expect(thread.getByText('检查或审批未通过')).toBeVisible()
    await expect(thread.getByRole('link', { name: '在 GitHub 打开' })).toHaveAttribute('href', pr)
    await expect(thread.getByRole('region', { name: '验收标准' })).toBeVisible()
    await expect(thread.getByText('无法合并', { exact: true })).toHaveCount(2)
    await shoot(page, 'merge-refused')
    merge = { ...merge!, id: randomUUID(), status: 'merged', code: null, createdAt: new Date().toISOString() }
    // Leave and come back to 验收 past SWR's dedupe window: the pane reads the ledger and the PR again.
    await page.waitForTimeout(2500)
    await thread.getByRole('tab', { name: '对话' }).click()
    await thread.getByRole('tab', { name: '验收' }).click()
    await expect(thread.getByText('已合并', { exact: true }).first()).toBeVisible()
    await expect(thread.getByRole('region', { name: '验收标准' })).toBeVisible()
    await expect(thread.getByRole('button', { name: '验收并合并' })).toHaveCount(0)
    await expect(thread.getByRole('link', { name: '在 GitHub 打开' })).toHaveAttribute('href', pr)
    await shoot(page, 'merged')
  })
})
