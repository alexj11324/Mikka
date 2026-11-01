import { chmodSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { consumeCloudBootstrap, installCloudCredential, watchCloudBootstraps } from '../src/cloud-bootstrap'
import { Daemon } from '../src/main'
import { MemoryServer } from '../src/server-link'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(cleanupTempDirs)
const config = () => ({ deviceId: randomUUID(), workspaceId: randomUUID(), credential: `orv_${'a'.repeat(43)}`, server: 'https://mikka.example/mikka' })

it('accepts and consumes a private scoped handoff', () => {
  const file = join(tempDir(), 'handoff')
  const input = config()
  writeFileSync(file, JSON.stringify(input), { mode: 0o600 })
  expect(consumeCloudBootstrap(file)).toEqual(input)
  expect(() => consumeCloudBootstrap(file)).toThrow()
})

it('a preloaded worker serializes atomic handoffs and duplicate wakes without baking an identity', async () => {
  const directory = tempDir(), path = join(directory, 'bootstrap.json'), next = join(directory, 'bootstrap.next')
  const first = config(), second = { ...first, credential: `orv_${'b'.repeat(43)}` }
  const received: string[] = []
  let entered!: () => void, release!: () => void, completed!: () => void, reject!: (error: unknown) => void
  const firstEntered = new Promise<void>(resolve => { entered = resolve })
  const holding = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>((resolve, fail) => { completed = resolve; reject = fail })
  const close = watchCloudBootstraps(directory, async () => {
    received.push(consumeCloudBootstrap(path).credential)
    if (received.length === 1) { entered(); await holding }
    if (received.length === 2) completed()
  }, reject)
  try {
    expect(received).toEqual([])
    writeFileSync(next, JSON.stringify(first), { mode: 0o600 })
    renameSync(next, path)
    await firstEntered
    writeFileSync(next, JSON.stringify(second), { mode: 0o600 })
    renameSync(next, path)
    process.emit('SIGUSR1'); process.emit('SIGUSR1')
    expect(received).toEqual([first.credential])
    release()
    await finished
    expect(received).toEqual([first.credential, second.credential])
  } finally { release(); close() }
})

it('keeps preview access in the private handoff and never persists it with device credentials', async () => {
  const directory = tempDir(), file = join(directory, 'handoff')
  const input = { ...config(), server: 'https://fixture.vercel.app/mikka', protectionBypass: 'fixture-preview-secret-1234567890' }
  writeFileSync(file, JSON.stringify(input), { mode: 0o600 })
  const consumed = consumeCloudBootstrap(file)
  expect(consumed).toEqual(input)
  expect(await installCloudCredential(directory, consumed)).toBe('start')
  expect(readFileSync(join(directory, 'device.json'), 'utf8')).not.toContain(input.protectionBypass)
  writeFileSync(file, JSON.stringify({ ...input, server: 'https://attacker.example/mikka' }), { mode: 0o600 })
  expect(() => consumeCloudBootstrap(file)).toThrow('Invalid cloud worker server')
})

it('seeds the bound device and rotates a running daemon through its private socket', async () => {
  const dataDir = tempDir(), input = config()
  expect(await installCloudCredential(dataDir, input)).toBe('start')
  const device = join(dataDir, 'device.json')
  expect(statSync(device).mode & 0o077).toBe(0)
  expect(JSON.parse(readFileSync(device, 'utf8'))).toEqual({ deviceId: input.deviceId, workspaceId: input.workspaceId, credential: input.credential })
  const daemon = await new Daemon({ dataDir, flavor: 'dev', agentSandbox: null, link: new MemoryServer(input.deviceId).link(), harnesses: [], quotaSource: null }).start()
  try {
    await daemon.syncWithServer()
    const rotated = { ...input, credential: `orv_${'b'.repeat(43)}` }
    expect(await installCloudCredential(dataDir, rotated)).toBe('updated')
    expect(JSON.parse(readFileSync(device, 'utf8')).credential).toBe(rotated.credential)
    await expect(installCloudCredential(dataDir, { ...rotated, deviceId: randomUUID() })).rejects.toThrow('identity changed')
    await expect(installCloudCredential(dataDir, { ...rotated, workspaceId: randomUUID() })).rejects.toThrow('identity changed')
  } finally { await daemon.stop() }
})
it('rejects public permissions, symlinks, unsafe server URLs and unknown fields', () => {
  const dir = tempDir(), file = join(dir, 'handoff'), link = join(dir, 'link')
  writeFileSync(file, JSON.stringify(config()), { mode: 0o600 })
  chmodSync(file, 0o644)
  expect(() => consumeCloudBootstrap(file)).toThrow()
  chmodSync(file, 0o600)
  symlinkSync(file, link)
  expect(() => consumeCloudBootstrap(link)).toThrow()
  for (const bad of [{ ...config(), server: 'http://mikka.example' }, { ...config(), server: 'https://user:password@mikka.example' }, { ...config(), server: 'https://mikka.example/?token=secret' }, { ...config(), extra: true }]) {
    writeFileSync(file, JSON.stringify(bad))
    expect(() => consumeCloudBootstrap(file)).toThrow()
  }
})
