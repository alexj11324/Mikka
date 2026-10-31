import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RepositoryCache } from '../src/repositories'
import { tempDir, waitFor } from './helpers'

describe('repository preparation cancellation', () => {
  it('terminates Git transport descendants and settles preparation', async () => {
    const root = tempDir('mikka-git-cancel-')
    const pidFile = join(root, 'transport.pid')
    const transport = join(root, 'transport.cjs')
    writeFileSync(transport, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const saved = { command: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT }
    process.env.GIT_SSH_COMMAND = `"${process.execPath}" "${transport}"`
    process.env.GIT_SSH_VARIANT = 'ssh'
    const controller = new AbortController()
    const preparing = new RepositoryCache(join(root, 'cache')).prepare('ssh://git@example.test/acceptance/cancel.git', controller.signal)
    // Attach the rejection handler before cancellation to avoid an unhandled
    // rejection. This is real Git with a controlled, non-network SSH child.
    const settled = preparing.then(() => false, () => true)
    let pid: number | undefined
    try {
      await waitFor(() => existsSync(pidFile))
      pid = Number(readFileSync(pidFile, 'utf8'))
      controller.abort()
      await expect(Promise.race([settled, new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))])).resolves.toBe(true)
      // A zombie has exited; only a still-running transport is a failure.
      await waitFor(() => {
        try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') }
        catch { return true }
      }, 2000)
    } finally {
      controller.abort()
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
      await settled
      if (saved.command === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = saved.command
      if (saved.variant === undefined) delete process.env.GIT_SSH_VARIANT
      else process.env.GIT_SSH_VARIANT = saved.variant
    }
  })
})
