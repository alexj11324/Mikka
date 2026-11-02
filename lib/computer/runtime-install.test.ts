import assert from 'node:assert/strict'
import test from 'node:test'
import { installComputerRuntime } from './e2b-provider'

test('a template with current runtime files starts without transferring files', async () => {
  let commands = 0
  const sandbox = {
    files: { write: async () => { assert.fail('current template must not rewrite its baked scripts') } },
    commands: { run: async (command: string, options: { user: string }) => {
      commands++
      assert.equal(options.user, 'root')
      assert.match(command, /sha256sum --check --status/)
      assert.doesNotMatch(command, /start-desktop\.sh/)
      assert.match(command, /head -c 32 \/dev\/urandom/)
      return { stdout: '' }
    } },
  } as unknown as Parameters<typeof installComputerRuntime>[0]
  await installComputerRuntime(sandbox)
  assert.equal(commands, 1)
})

test('an older task snapshot updates guards without replacing its baked desktop', async () => {
  let current = false, commands = 0, transfers = 0
  const sandbox = {
    files: { write: async (files: { path: string; data: string }[], options: { user: string }) => {
      assert.equal(options.user, 'root')
      assert.equal(commands, 1)
      assert.deepEqual(files.map(file => file.path.split('/').at(-1)), ['viewer-gateway.py', 'lease-driver.py'])
      assert.ok(files.every(file => file.data.length > 0))
      transfers++; current = true
    } },
    commands: { run: async () => { commands++; return { stdout: current ? '' : 'mikka-runtime-install-required' } } },
  } as unknown as Parameters<typeof installComputerRuntime>[0]
  await installComputerRuntime(sandbox)
  assert.equal(transfers, 1)
  assert.equal(commands, 2)
})

test('a partial installation cannot be marked ready', async () => {
  const sandbox = {
    files: { write: async () => {} },
    commands: { run: async () => ({ stdout: 'mikka-runtime-install-required' }) },
  } as unknown as Parameters<typeof installComputerRuntime>[0]
  await assert.rejects(installComputerRuntime(sandbox), /installation failed/)
})
