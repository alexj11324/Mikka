import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Sandbox } from 'e2b'
import { startExternalServices } from './external-services.mjs'
import { createLocalE2BProcesses } from './e2b-process.mjs'

test('E2B SDK executes real isolated processes, streams stdin, retains files and kills the owned VM', async t => {
  const processes = await createLocalE2BProcesses()
  const services = await startExternalServices({ e2b: { processes } })
  t.after(() => services.close())
  const sandbox = await Sandbox.create('claude', services.e2bOptions)
  await sandbox.files.write('/home/user/input.txt', 'real bytes\n')
  assert.equal((await sandbox.commands.run('cat input.txt && printf output > result.txt')).stdout, 'real bytes\n')
  assert.equal(await sandbox.files.read('/home/user/result.txt'), 'output')
  assert.equal((await sandbox.commands.run('test ! -e /workspace && test ! -e /root/.git-credentials && printf isolated')).stdout, 'isolated')
  await sandbox.commands.run('ln -s /workspace out')
  await assert.rejects(sandbox.files.write('/home/user/out/escape.txt', 'must not escape'))
  const command = await sandbox.commands.run('read -r line; printf "received:%s" "$line"', { stdin: true, background: true })
  const input = sandbox.commands.streamInput(command.pid)
  await input.send('HTTP body\n')
  await input.close()
  assert.equal((await command.wait()).stdout, 'received:HTTP body')
  const running = await sandbox.commands.run('read -r line', { stdin: true, background: true })
  assert.equal(await sandbox.commands.kill(running.pid), true)
  await assert.rejects(running.wait(), error => error.exitCode !== 0)
  await Sandbox.kill(sandbox.sandboxId, services.e2bOptions)
  assert.ok(services.e2b.requests.some(request => request.path.endsWith('/StreamInput')))
})
