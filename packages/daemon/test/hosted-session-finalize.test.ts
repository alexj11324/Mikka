import { expect, it } from 'vitest'
import { finalizeHostedSession } from '../src/hosted-session-finalize'

it('captures the final tail only after the native process has exited', async () => {
  let transcript = 'before exit'
  let captured = ''
  await finalizeHostedSession(async () => { transcript += '\nfinal tail' }, async () => { captured = transcript })
  expect(captured).toBe('before exit\nfinal tail')
})

it('never saves after an unconfirmed exit and propagates save failure', async () => {
  let writes = 0
  await expect(finalizeHostedSession(async () => { throw Error('exit not confirmed') }, async () => { writes++ })).rejects.toThrow('exit not confirmed')
  expect(writes).toBe(0)
  await expect(finalizeHostedSession(async () => {}, async () => { throw Error('snapshot too large') })).rejects.toThrow('snapshot too large')
})

it('captures tail flushed by a real synthetic child during graceful exit', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mikka-finalize-retained-'))
  const file = join(root, 'transcript')
  const source = `const fs=require('node:fs'); fs.writeFileSync(process.argv[1],'start'); process.stdin.resume(); process.stdin.on('end',()=>{fs.appendFileSync(process.argv[1],'\\nexit tail');process.exit(0)})`
  const child = spawn(process.execPath, ['-e', source, file], {stdio:['pipe','pipe','pipe']})
  const exited = new Promise<number|null>((resolve,reject) => { child.once('exit', resolve); child.once('error', reject) })
  let captured = ''
  await finalizeHostedSession(async () => { child.stdin.end(); expect(await exited).toBe(0) }, async () => { captured=readFileSync(file,'utf8') })
  expect(captured).toBe('start\nexit tail')
})
