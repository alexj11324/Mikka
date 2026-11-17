import { expect, it, vi } from 'vitest'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type ServerLink } from '../src/server-link'

it('a started daemon never polls for folder requests: the app adds repositories by path', async () => {
  const { tempDir, cleanupTempDirs } = await import('./helpers')
  const fetchFsRequests = vi.fn<NonNullable<ServerLink['fetchFsRequests']>>(async () => [])
  const link = { ...new MemoryServer('device-1').link(), fetchFsRequests, answerFsRequest: vi.fn(async () => {}) }
  const daemon = await new Daemon({ dataDir: tempDir(), flavor: 'dev', agentSandbox: null, link, harnesses: [], quotaSource: null, log: createLogger({ level: 'silent' }) }).start()
  try {
    // A registered device with an open session.
    Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
    Reflect.set(daemon, 'registered', true)
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(fetchFsRequests).not.toHaveBeenCalled()
  } finally {
    await daemon.stop()
    cleanupTempDirs()
  }
})
