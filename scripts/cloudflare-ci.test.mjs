import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { hasGitHubOrigin } from './cloudflare-source.mjs'
import { childEnvironment, sourceContext, validateReceipt } from './cloudflare-ci.mjs'

const publicSha = 'a'.repeat(40)
const privateSha = 'b'.repeat(40)
const env = { WORKERS_CI: '1', WORKERS_CI_COMMIT_SHA: publicSha, WORKERS_CI_BRANCH: 'main',
  WORKERS_CI_BUILD_UUID: '12345678-1234-1234-1234-123456789abc', MIKKA_CF_RELEASE_OVERLAY_SHA: privateSha }
const context = sourceContext(env, publicSha, privateSha)
const receipt = { version: 1, context, provider: context.provider, publicSha, privateSha, target: 'native-api', publication: 'none',
  overlayCheckout: { repository: 'alexj11324/mikka-hosted-ui', requestedSha: privateSha, actualSha: privateSha },
  stages: ['public-install', 'private-install', 'script-tests'].map(name => ({ name, exit: 0 })) }

test('the native build belongs to the public checkout and pins the private overlay', () => {
  assert.equal(context.publicSha, publicSha)
  assert.equal(context.privateSha, privateSha)
  assert.throws(() => sourceContext({ ...env, WORKERS_CI_COMMIT_SHA: privateSha }, publicSha, privateSha), /CI_PUBLIC_SOURCE_MISMATCH/)
  assert.throws(() => sourceContext({ ...env, MIKKA_CF_RELEASE_OVERLAY_SHA: publicSha }, publicSha, privateSha), /CI_OVERLAY_SOURCE_MISMATCH/)
  assert.throws(() => sourceContext({ ...env, WORKERS_CI: undefined }, publicSha, privateSha), /CI_CLOUDFLARE_CONTEXT_REQUIRED/)
})

test('a receipt binds both checked-out sources, build and completed stages', () => {
  assert.equal(validateReceipt(receipt, context), receipt)
  assert.throws(() => validateReceipt({ ...receipt, overlayCheckout: { ...receipt.overlayCheckout, actualSha: publicSha } }, context), /CI_OVERLAY_RECEIPT_MISMATCH/)
  assert.throws(() => validateReceipt({ ...receipt, context: { ...context, buildId: 'different' } }, context), /CI_RECEIPT_SOURCE_MISMATCH/)
  assert.throws(() => validateReceipt({ ...receipt, stages: receipt.stages.slice(1) }, context), /CI_RECEIPT_GATE_INCOMPLETE/)
  assert.throws(() => validateReceipt({ ...receipt, target: 'renderers' }, context), /CI_RECEIPT_GATE_INCOMPLETE/)
})

test('compiler children receive source identities without checkout or publication credentials', () => {
  const child = childEnvironment({ PATH: '/bin', HOSTED_UI_READ_KEY: 'private', CLOUDFLARE_API_TOKEN: 'private', DOCKER_HOST: 'unix:///tmp/docker.sock' }, publicSha, privateSha)
  assert.equal(child.MIKKA_BUILD_REVISION, publicSha)
  assert.equal(child.MIKKA_UI_OVERLAY_SHA, privateSha)
  assert.equal(child.DOCKER_HOST, 'unix:///tmp/docker.sock')
  assert.equal(child.HOSTED_UI_READ_KEY, undefined)
  assert.equal(child.CLOUDFLARE_API_TOKEN, undefined)
  assert.equal(childEnvironment({ DOCKER_HOST: 'tcp://remote:2375' }, publicSha, privateSha).DOCKER_HOST, undefined)
})

test('release compilation occurs once in the public native publisher', async () => {
  const source = await readFile(new URL('./cloudflare-ci.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes("env.MIKKA_CF_RELEASE_MODE === 'registry-only' ? 'native-api' : 'renderers'"))
  assert.ok(source.includes("if (target === 'renderers') definitions.push("))
  assert.ok(!source.includes('.hosted-ui/scripts/*.test.mjs'))
  assert.ok(!source.includes('git@github.com:alexj11324/Mikka.git'))
})


test('GitHub origins normalize authenticated HTTPS and SSH repository names without logging credentials', () => {
  for (const origin of [
    'https://github.com/alexj11324/Mikka.git',
    'https://x-access-token:private-sentinel@github.com/ALEXJ11324/mikka.git',
    'https://private-sentinel@GITHUB.COM/alexj11324/Mikka/',
    'git@github.com:alexj11324/Mikka.git',
    'ssh://git@github.com/alexj11324/mikka.git',
  ]) assert.equal(hasGitHubOrigin(origin, 'alexj11324/Mikka'), true)
  const output = []
  const original = console.error
  console.error = value => output.push(value)
  try {
    for (const origin of [
      'https://private-sentinel@github.com/other/Mikka.git',
      'https://private-sentinel@github.com.example/alexj11324/Mikka.git',
      'http://github.com/alexj11324/Mikka.git',
      'https://github.com:8443/alexj11324/Mikka.git',
      'file:///private-sentinel/alexj11324/Mikka',
      'private-sentinel',
    ]) assert.equal(hasGitHubOrigin(origin, 'alexj11324/Mikka'), false)
  } finally {
    console.error = original
  }
  assert.equal(output.length, 6)
  assert.ok(output.every(line => !line.includes('private-sentinel')))
})
