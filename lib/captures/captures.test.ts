import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { captureFileResponse } from './serve'
import { captureScreenshot, startScreenRecording, stopScreenRecording } from '../computer/e2b-provider'

const run = promisify(execFile)
const file = { id: '6f1d8c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f', kind: 'video' as const, contentType: 'video/mp4' as const, title: 'Flow', size: 10, durationMs: 1000, source: 'local' as const, createdAt: new Date(0).toISOString(), bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) }
const get = (range?: string) => captureFileResponse(new Request('https://mikka.test/api/captures/x', range ? { headers: { range } } : {}), file)

test('a capture is served as media that never runs as a page, with byte ranges for seeking', async () => {
  const whole = get()
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('content-type'), 'video/mp4')
  assert.equal(whole.headers.get('x-content-type-options'), 'nosniff')
  assert.match(whole.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), file.bytes)
  const part = get('bytes=2-4')
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10')
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [2, 3, 4])
  assert.deepEqual([...new Uint8Array(await get('bytes=7-').arrayBuffer())], [7, 8, 9])
  assert.deepEqual([...new Uint8Array(await get('bytes=-2').arrayBuffer())], [8, 9])
  assert.equal(get('bytes=10-').status, 416)
  assert.equal(get('bytes=0-1,4-5').status, 200, 'several ranges get the whole file')
})

test('the sandbox capture script refuses anything but a display number, a capture id and a bounded length', async () => {
  const script = fileURLToPath(new URL('../../scripts/e2b/screen-capture.sh', import.meta.url))
  const id = '6f1d8c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f'
  for (const args of [['shot', '0', id], ['shot', ':2', id], ['shot', '2', '../../etc/passwd'], ['shot', '2', `${id};rm -rf /`], ['record', '2', id, '3600'], ['record', '2', id, '1'], ['exec', '2', id]]) {
    await assert.rejects(run('bash', [script, ...args], { env: { ...process.env, MIKKA_CAPTURE_DIR: '/nonexistent/never-created' } }), (error: { code?: number }) => error.code === 2, args.join(' '))
  }
})

test('the provider checks the display and id before it touches the sandbox', async () => {
  const touched: string[] = []
  const sandbox = {
    files: { write: async (path: string) => { touched.push(path) }, read: async () => new Uint8Array() },
    commands: { run: async (command: string) => { touched.push(command); return { stdout: '' } } },
  } as unknown as Parameters<typeof captureScreenshot>[0]
  await assert.rejects(captureScreenshot(sandbox, 0, '6f1d8c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f'))
  await assert.rejects(captureScreenshot(sandbox, 2, 'x; reboot'))
  await assert.rejects(startScreenRecording(sandbox, 2, '6f1d8c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f', 3600))
  await assert.rejects(stopScreenRecording(sandbox, 1000, '6f1d8c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f'))
  assert.deepEqual(touched, [])
})
