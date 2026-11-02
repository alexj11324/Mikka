import type { WebSocketRoute } from '@playwright/test'
import { test, expect, register } from './fixtures'

// Real noVNC decodes this bounded RFB server. It deliberately withholds the next
// frame during signed-grant changes; server authority is checked separately by
// viewer-gateway tests against the real x11vnc sockets.
test('computer viewer keeps the desktop through handoff and renewal, with full preview and backdrop targets', async ({ page, allowedConsoleErrors }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  let controlled = false
  let userId = ''
  let epoch = 0
  let serial = 0
  let holdFrames = false
  let inputs = 0
  let denied = false
  let viewerPath = ''
  const sockets = new Set<WebSocketRoute>()
  const pending = new Set<() => void>()
  const grant = (mode: string) => ({ url: `wss://viewer.test/${mode}/${epoch}/${++serial}`, expiresAt: new Date(Date.now() + 35_000).toISOString() })
  const revoke = () => { epoch++; for (const socket of sockets) socket.close(); sockets.clear() }
  const release = () => { holdFrames = false; for (const send of pending) send(); pending.clear() }
  await page.routeWebSocket('wss://viewer.test/**', socket => {
    sockets.add(socket)
    let phase = 0
    let sent = false
    socket.send(Buffer.from('RFB 003.008\n'))
    socket.onMessage(message => {
      const data = Buffer.from(message)
      if (phase++ === 0) { socket.send(Buffer.from([1, 1])); return }
      if (phase === 2) { socket.send(Buffer.alloc(4)); return }
      if (phase === 3) {
        const init = Buffer.alloc(31)
        init.writeUInt16BE(1280, 0); init.writeUInt16BE(800, 2)
        init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4)
        init.writeUInt32BE(7, 20); init.write('Fixture', 24)
        socket.send(init)
        return
      }
      if (data[0] === 4 || data[0] === 5) inputs++
      if (data[0] !== 3 || sent) return
      sent = true
      const send = () => {
        const frame = Buffer.alloc(16 + 1280 * 800 * 4)
        frame.writeUInt16BE(1, 2); frame.writeUInt16BE(1280, 8); frame.writeUInt16BE(800, 10)
        for (let i = 16; i < frame.length; i += 4) frame.set([55, 135, 195, 0], i)
        if (sockets.has(socket)) socket.send(frame)
      }
      if (holdFrames) pending.add(send)
      else send()
    })
    socket.onClose(() => { sockets.delete(socket); socket.close() })
  })
  await page.route('**/api/settings/e2b-key?*', route => route.fulfill({ json: { configured: true } }))
  await page.route('**/api/bots/*/computer', route => route.fulfill({ json: { machine: 'running', control: controlled ? 'user' : 'agent', ...(controlled ? { controlledBy: { userId } } : {}) } }))
  await page.route('**/api/bots/*/computer/viewer', route => {
    viewerPath = new URL(route.request().url()).pathname
    return denied ? route.fulfill({ status: 403, json: { error: 'forbidden' } }) : route.fulfill({ json: grant(route.request().postDataJSON().mode) })
  })
  await page.route('**/api/bots/*/computer/takeover', route => { controlled = true; revoke(); return route.fulfill({ json: grant('control') }) })
  await page.route('**/api/bots/*/computer/handback', route => { controlled = false; revoke(); return route.fulfill({ status: 204 }) })
  await register(page)
  // Playwright's routed WebSocket adds an empty subclass; noVNC validates only
  // own properties and the immediate prototype. Expose its public channel API.
  await page.evaluate(() => {
    const prototype = WebSocket.prototype
    const inherited = Object.getPrototypeOf(prototype)
    for (const name of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen']) {
      const descriptor = Object.getOwnPropertyDescriptor(inherited, name)
      if (descriptor) Object.defineProperty(prototype, name, descriptor)
    }
  })
  const session = await page.request.get('/mikka/api/auth/get-session')
  userId = (await session.json()).user.id
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const create = page.getByRole('dialog', { name: '新建 Bot' })
  await create.getByLabel('名字', { exact: true }).fill('Viewer fixture')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await expect(create).toBeHidden()
  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  await panel.getByRole('tab', { name: '电脑', exact: true }).click()
  const preview = panel.getByRole('button', { name: '全屏查看 Viewer fixture 的屏幕', exact: true })
  await expect(preview).toBeVisible()
  await expect(preview.locator('button')).toHaveCount(0)
  const viewer = page.getByRole('dialog', { name: 'Viewer fixture 的屏幕', exact: true })
  const screen = viewer.getByRole('img', { name: 'Viewer fixture 的屏幕', exact: true })
  const waitFrame = async () => expect.poll(() => screen.locator('canvas').last().evaluate(canvas => (canvas as HTMLCanvasElement).getContext('2d')?.getImageData(500, 400, 1, 1).data[3] ?? 0)).toBe(255)

  // Both blank sides of the preview and keyboard activation use the same button.
  for (const side of ['left', 'right', 'keyboard']) {
    if (side === 'keyboard') { await preview.focus(); await page.keyboard.press('Enter') }
    else {
      const box = await preview.boundingBox()
      if (!box) throw new Error('Preview has no click area')
      await page.mouse.click(box.x + (side === 'left' ? 12 : box.width - 12), box.y + box.height / 2)
    }
    await expect(viewer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
  }
  expect(inputs).toBe(0)
  await preview.click({ position: { x: 12, y: 12 } })
  await waitFrame()
  await page.mouse.move(20, 20)
  const before = await screen.screenshot()
  await info.attach('computer-frame-before', { body: before, contentType: 'image/png' })
  holdFrames = true
  await viewer.getByRole('button', { name: '取得控制权', exact: true }).click()
  await expect(viewer.getByRole('button', { name: '交还给 Bot', exact: true })).toBeEnabled()
  await expect.poll(() => pending.size).toBeGreaterThan(0)
  const takeoverFrame = await screen.screenshot()
  await info.attach('computer-frame-takeover', { body: takeoverFrame, contentType: 'image/png' })
  expect(takeoverFrame).toEqual(before)
  expect(await screen.evaluate(node => getComputedStyle(node.parentElement!.parentElement!).boxShadow)).toBe('none')
  release()
  await waitFrame()
  await screen.click({ position: { x: 100, y: 100 } })
  await expect(viewer).toBeVisible()
  await expect.poll(() => inputs).toBeGreaterThan(0)
  holdFrames = true
  await viewer.getByRole('button', { name: '交还给 Bot', exact: true }).click()
  await expect(viewer.getByRole('button', { name: '取得控制权', exact: true })).toBeEnabled()
  await expect.poll(() => pending.size).toBeGreaterThan(0)
  expect(await screen.screenshot()).toEqual(before)
  release()
  await waitFrame()
  const inputAfterHandback = inputs
  await screen.click({ position: { x: 100, y: 100 } })
  await expect(viewer).toBeVisible()
  expect(inputs).toBe(inputAfterHandback)

  // Renewal must also keep the last frame, while still making a fresh connection.
  holdFrames = true
  const previousSerial = serial
  await expect.poll(() => serial, { timeout: 10_000 }).toBeGreaterThan(previousSerial)
  await expect.poll(() => pending.size).toBeGreaterThan(0)
  expect(await screen.screenshot()).toEqual(before)
  release()
  await waitFrame()
  await info.attach('computer-viewer-light', { body: await viewer.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await info.attach('computer-viewer-dark', { body: await viewer.screenshot(), contentType: 'image/png' })
  await page.setViewportSize({ width: 1024, height: 768 })
  await info.attach('computer-viewer-narrow', { body: await viewer.screenshot(), contentType: 'image/png' })
  await page.setViewportSize({ width: 1440, height: 960 })
  for (const position of [{ x: 720, y: 8 }, { x: 720, y: 952 }, { x: 8, y: 480 }, { x: 1432, y: 480 }]) {
    await page.mouse.click(position.x, position.y)
    await expect(viewer).toHaveCount(0)
    await preview.click({ position: { x: 12, y: 12 } })
    await expect(viewer).toBeVisible()
  }
  await viewer.getByRole('button', { name: '取得控制权', exact: true }).click()
  await expect(viewer.getByRole('button', { name: '交还给 Bot', exact: true })).toBeVisible()
  await viewer.getByRole('button', { name: '退出全屏', exact: true }).click()
  await expect(viewer).toHaveCount(0)
  await expect.poll(() => controlled).toBe(false)
  await preview.click({ position: { x: 12, y: 12 } })
  await waitFrame()
  allowedConsoleErrors.push({ message: 'Failed to load resource: the server responded with a status of 403 (Forbidden)', path: viewerPath })
  denied = true
  await expect(screen).toHaveCount(0, { timeout: 10_000 })
  await expect(viewer.getByRole('button', { name: '重试', exact: true })).toBeVisible()
})
