import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Sandbox, SandboxNotFoundError, SandboxError, RateLimitError, AuthenticationError } from 'e2b'
import { startExternalServices } from './external-services.mjs'

test('real E2B SDK creates, reconnects, streams commands, reads/writes files and kills over HTTP', async t => {
  const services = await startExternalServices({ e2b: { commands: { 'printf hello': { stdout: 'hello' }, 'exit 7': { exitCode: 7, stderr: 'refused' } } } })
  t.after(() => services.close())
  const options = services.e2bOptions
  const sandbox = await Sandbox.create('codex', { ...options, idempotencyKey: 'fixture-create-1', metadata: { application: 'mikka' } })
  assert.equal((await Sandbox.create('codex', { ...options, idempotencyKey: 'fixture-create-1' })).sandboxId, sandbox.sandboxId)
  assert.equal((await Sandbox.getInfo(sandbox.sandboxId, options)).metadata.application, 'mikka')
  const connected = await Sandbox.connect(sandbox.sandboxId, options)
  await connected.files.write('/home/user/example.txt', 'fixture bytes')
  assert.equal(await connected.files.read('/home/user/example.txt'), 'fixture bytes')
  const chunks = []
  assert.equal((await connected.commands.run('printf hello', { onStdout: chunk => chunks.push(chunk) })).stdout, 'hello')
  assert.deepEqual(chunks, ['hello'])
  await assert.rejects(connected.commands.run('exit 7'), error => error.exitCode === 7 && error.stderr === 'refused')
  assert.equal(await Sandbox.kill(sandbox.sandboxId, options), true)
  await assert.rejects(Sandbox.connect(sandbox.sandboxId, options), SandboxNotFoundError)
  assert.ok(services.e2b.requests.some(request => request.path.endsWith('/process.Process/Start') && request.body.process.args.at(-1) === 'printf hello'))
  assert.ok(services.e2b.requests.every(request => !Object.hasOwn(request.headers, 'x-api-key')))
})

test('real E2B SDK rejects auth, unknown templates, allocation limits, reclaimed sandboxes and timed-out commands', async t => {
  const services = await startExternalServices({ e2b: { limit: 1, commands: { 'long command': { timeout: true } } } })
  t.after(() => services.close())
  const options = services.e2bOptions
  await assert.rejects(Sandbox.create('base', { ...options, apiKey: 'invalid-fixture-key' }), AuthenticationError)
  // e2b@2.61 maps the control API's template 404 to SandboxError.statusCode;
  // SandboxNotFoundError is reserved for the connect/get-info path.
  await assert.rejects(Sandbox.create('missing-template', options), error => error instanceof SandboxError && error.statusCode === 404)
  const sandbox = await Sandbox.create('base', options)
  await assert.rejects(Sandbox.create('base', options), RateLimitError)
  await assert.rejects(sandbox.commands.run('long command'), /timed out|deadline/i)
  services.e2b.expire(sandbox.sandboxId)
  await assert.rejects(Sandbox.connect(sandbox.sandboxId, options), SandboxNotFoundError)
})
