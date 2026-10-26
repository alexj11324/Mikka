import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ComputerBroker } from '../src/computer/broker.mjs'
import { Daemon } from '../src/main'
import { MemoryServer } from '../src/server-link'
import { connectDaemonInDataDir } from '../src/rpc/client'
import { cleanupTempDirs, tempDir, waitFor } from './helpers'

afterEach(cleanupTempDirs)

it('starts computer review sync only for the registered device and cancels it on shutdown', async () => {
  const dir = tempDir()
  let calls = 0
  const broker = new ComputerBroker({ socketPath: join(dir, 'computer.sock'),
    driver: { installed: true, path: '/fake', version: 'test', fingerprint: 'f'.repeat(64) }, permitted: () => true,
    execute: async () => 'approved',
  })
  const grant = broker.spec(randomUUID(), 'ask', { display: ':1' })!
  const pending = broker.request(grant.token, { name: 'click', arguments: { x: 1, y: 2 } })
  const link = Object.assign(new MemoryServer('device-1').link(), { async syncComputerReviews(deviceId: string, requests: { id: string; digest: string }[]) {
    calls++
    expect(deviceId).toBe('device-1')
    return requests.map(({ id, digest }) => ({ id, digest, approve: true }))
  } })
  const daemon = await new Daemon({ dataDir: tempDir(), flavor: 'dev', link, credential: 'fixture', computerBroker: broker,
    harnesses: [{ harness: 'mock', installed: true, version: 'test' }], quotaSource: null }).start()
  try {
    await daemon.syncWithServer()
    expect(await pending).toBe('approved')
    expect(calls).toBe(1)
    await daemon.stop()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toBe(1)
  } finally { await daemon.stop(); await broker.close() }
})

it.each(['device.clearCredential', 'device.setCredential'] as const)('%s discards an old in-flight approval response', async method => {
  const broker = new ComputerBroker({ socketPath: join(tempDir(), 'computer.sock'),
    driver: { installed: true, path: '/fake', version: 'test', fingerprint: 'f'.repeat(64) }, permitted: () => true,
    execute: async () => { throw new Error('old session must not execute') },
  })
  const grant = broker.spec(randomUUID(), 'ask', { display: ':1' })!
  const pending = broker.request(grant.token, { name: 'click', arguments: { x: 1, y: 2 } }).catch(() => undefined)
  let release: (() => void) | undefined
  const link = Object.assign(new MemoryServer('device-1').link(), { syncComputerReviews(_device: string, requests: { id: string; digest: string }[], signal?: AbortSignal) {
    return new Promise<{ id: string; digest: string; approve: boolean }[]>(resolve => {
      if (!release) release = () => resolve(requests.map(({ id, digest }) => ({ id, digest, approve: true })))
      else signal?.addEventListener('abort', () => resolve([]), { once: true })
    })
  } })
  const dataDir = tempDir()
  const daemon = await new Daemon({ dataDir, flavor: 'dev', link, credential: 'fixture', computerBroker: broker,
    harnesses: [{ harness: 'mock', installed: true, version: 'test' }], quotaSource: null }).start()
  try {
    await daemon.syncWithServer()
    await waitFor(() => release)
    const client = await connectDaemonInDataDir(dataDir, { name: 'test', version: '0' })
    if (method === 'device.clearCredential') await client.request(method)
    else await client.request(method, { credential: 'rotated' })
    client.close()
    release!()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(broker.list()).toHaveLength(1)
  } finally { await daemon.stop(); await broker.close(); await pending }
})
