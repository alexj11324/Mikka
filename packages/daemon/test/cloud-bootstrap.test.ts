import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { consumeCloudBootstrap, installCloudCredential } from '../src/cloud-bootstrap'
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

it('seeds the bound device and rotates a running daemon through its private socket', async () => {
  const dataDir = tempDir(), input = config()
  expect(await installCloudCredential(dataDir, input)).toBe('start')
  const device = join(dataDir, 'device.json')
  expect(statSync(device).mode & 0o077).toBe(0)
  expect(JSON.parse(readFileSync(device, 'utf8'))).toEqual({ deviceId: input.deviceId, workspaceId: input.workspaceId, credential: input.credential })
  const daemon = await new Daemon({ dataDir, flavor: 'dev', link: new MemoryServer(input.deviceId).link(), harnesses: [], quotaSource: null }).start()
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
