import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runHostedCommand } from '../src/subscription-hosted-runner'
import { cleanupTempDirs, tempDir, waitFor } from './helpers'

afterEach(cleanupTempDirs)
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function waitForStoppedPid(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Expected a positive, safe integer PID')
  // Linux can close inherited pipes during do_exit before /proc reports Z/X.
  // Still require a terminal state or an absent PID within this short bound.
  await waitFor(() => {
    if (process.platform === 'linux') {
      try { return /\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // A different /proc namespace can hide a live child. Confirm absence.
      }
    }
    try { process.kill(pid, 0); return false }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
  }, 1000)
}

function fixture() {
  const root = tempDir(), binary = join(root, 'child.cjs'), ready = join(root, 'ready'), stopped = join(root, 'stopped')
  writeFileSync(binary, `const fs = require('node:fs')
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'SIGTERM'); process.exit(0) })
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid))
setInterval(() => {}, 1000)
`)
  // A real shell remains the group leader. Its child must receive SIGTERM;
  // killing only /bin/sh leaves the interval and inherited pipes alive.
  const script = `trap 'wait "$kid"; exit 143' TERM\n${quote(process.execPath)} ${quote(binary)} &\nkid=$!\nwait "$kid"`
  return { root, ready, stopped, script, binary }
}

it('cancellation stops a real verification shell and its child before returning', async () => {
  const f = fixture(), controller = new AbortController()
  const command = runHostedCommand(f.root, f.script, false, 10_000, controller.signal)
  await waitFor(() => existsSync(f.ready))
  const pid = Number(readFileSync(f.ready, 'utf8'))
  controller.abort()
  const result = await command
  expect(result).toMatchObject({ timedOut: false, output: 'hosted_command_failed' })
  expect(result.exitCode).not.toBe(0)
  expect(readFileSync(f.stopped, 'utf8')).toBe('SIGTERM')
  expect(() => process.kill(pid, 0)).toThrow()
})

it('a verification timeout also terminates shell descendants and remains distinct from cancellation', async () => {
  const f = fixture()
  const result = await runHostedCommand(f.root, f.script, false, 1500)
  expect(result).toMatchObject({ timedOut: true, output: 'hosted_command_failed' })
  expect(readFileSync(f.stopped, 'utf8')).toBe('SIGTERM')
  expect(() => process.kill(Number(readFileSync(f.ready, 'utf8')), 0)).toThrow()
})

it('an already cancelled verification never starts a shell', async () => {
  const root = tempDir(), marker = join(root, 'must-not-run'), controller = new AbortController()
  controller.abort()
  expect(await runHostedCommand(root, `printf started > ${quote(marker)}`, false, 1000, controller.signal))
    .toMatchObject({ exitCode: null, timedOut: false, output: 'hosted_command_failed' })
  expect(existsSync(marker)).toBe(false)
})

it('keeps bounded successful output and removes descendants when their shell exits first', async () => {
  const f = fixture()
  const result = await runHostedCommand(f.root,
    `${quote(process.execPath)} ${quote(f.binary)} &\nwhile [ ! -s ${quote(f.ready)} ]; do sleep 0.01; done\nprintf complete`, false, 5000)
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, output: 'complete' })
  const pid = Number(readFileSync(f.ready, 'utf8'))
  await waitForStoppedPid(pid)
})

it('does not accept a live child as a stopped verification process', async () => {
  const f = fixture(), controller = new AbortController()
  const command = runHostedCommand(f.root, f.script, false, 10_000, controller.signal)
  let pid: number | undefined
  try {
    pid = await waitFor(() => {
      try {
        const value = readFileSync(f.ready, 'utf8')
        const candidate = Number(value)
        return value.length > 0 && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }, 5000)
    await expect(waitForStoppedPid(pid)).rejects.toThrow('waitFor timed out')
    expect(existsSync(f.stopped)).toBe(false)
  } finally {
    controller.abort()
    await command
    if (pid !== undefined) await waitForStoppedPid(pid)
  }
})
