import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePinnedPnpm } from './pinned-pnpm.mjs'

const pin = 'pnpm@10.34.3'
function fakeCommands(responses) {
  const calls = []
  return {
    calls,
    execute(file, args, options) {
      calls.push({ file, args, options })
      const response = responses[file]
      if (response instanceof Error) throw response
      assert.equal(typeof response, 'string', `UNEXPECTED_COMMAND_${file}`)
      return response
    },
  }
}

test('the exact native pnpm installed by CI needs no Corepack', () => {
  const fake = fakeCommands({ pnpm: '10.34.3\n' })
  assert.deepEqual(resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }),
    { file: 'pnpm', args: [], version: '10.34.3' })
  assert.deepEqual(fake.calls.map(({ file, args }) => ({ file, args })), [{ file: 'pnpm', args: ['--version'] }])
})

test('an absent native executable falls back to the explicit cached Corepack pin', () => {
  const fake = fakeCommands({ pnpm: Object.assign(new Error('NOT_INSTALLED'), { code: 'ENOENT' }), corepack: '10.34.3\n' })
  assert.deepEqual(resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }),
    { file: 'corepack', args: [pin], version: '10.34.3' })
  assert.deepEqual(fake.calls.map(({ file, args }) => ({ file, args })), [
    { file: 'pnpm', args: ['--version'] }, { file: 'corepack', args: [pin, '--version'] },
  ])
})

test('a native version mismatch does not pass and can use the cached exact pin', () => {
  const fake = fakeCommands({ pnpm: '11.0.0\n', corepack: '10.34.3\n' })
  assert.equal(resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }).file, 'corepack')
  assert.equal(fake.calls.length, 2)
})

test('both candidates must actually report the exact version', () => {
  for (const native of ['11.0.0\n', '10.34.3\n11.0.0\n', '', new Error('NATIVE_FAILED')]) {
    const fake = fakeCommands({ pnpm: native, corepack: '10.34.2\n' })
    assert.throws(() => resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }), error => {
      assert.equal(error.message, 'MISSING_PINNED_PNPM')
      assert.equal(error.cause.errors.length, 2)
      return true
    })
  }
})

test('an unavailable cached Corepack version remains a failure with its cause', () => {
  const missing = new Error('COREPACK_NETWORK_DISABLED')
  const fake = fakeCommands({ pnpm: new Error('NOT_INSTALLED'), corepack: missing })
  assert.throws(() => resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }), error => {
    assert.equal(error.message, 'MISSING_PINNED_PNPM')
    assert.equal(error.cause.errors[1], missing)
    return true
  })
})

test('version-only probes disable manager downloads and retain only local cache selectors', () => {
  const fake = fakeCommands({ pnpm: '11.0.0', corepack: '10.34.3' })
  const env = { PATH: '/fixture/bin', HOME: '/fixture/home', COREPACK_HOME: '/fixture/cache', XDG_CACHE_HOME: '/fixture/xdg',
    NODE_OPTIONS: '--require untrusted', GH_TOKEN: 'fixture-secret', HTTPS_PROXY: 'fixture-proxy',
    COREPACK_ENABLE_NETWORK: '1', npm_config_manage_package_manager_versions: 'true', pnpm_config_pm_on_fail: 'download' }
  resolvePinnedPnpm({ packageManager: pin, execute: fake.execute, env })
  for (const { options } of fake.calls) {
    assert.deepEqual(options.env, {
      PATH: env.PATH, HOME: env.HOME, COREPACK_HOME: env.COREPACK_HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME,
      NODE_OPTIONS: '', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_PROJECT_SPEC: '0',
      npm_config_manage_package_manager_versions: 'false', pnpm_config_pm_on_fail: 'ignore',
    })
    assert.equal(options.timeout, 15_000)
    assert.equal(options.maxBuffer, 64 * 1024)
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(options.shell, undefined)
  }
  assert.equal(env.COREPACK_ENABLE_NETWORK, '1')
})

test('an integrity suffix is retained for Corepack while actual version output is still checked', () => {
  const integrityPin = `${pin}+sha512.${'a'.repeat(128)}`
  const fake = fakeCommands({ pnpm: '11.0.0', corepack: '10.34.3' })
  assert.deepEqual(resolvePinnedPnpm({ packageManager: integrityPin, execute: fake.execute }).args, [integrityPin])
})

test('unpinned managers fail before any command runs', () => {
  for (const packageManager of ['pnpm@latest', 'pnpm@^10.34.3', 'npm@10.34.3', 'pnpm@10.34.3;true']) {
    const fake = fakeCommands({})
    assert.throws(() => resolvePinnedPnpm({ packageManager, execute: fake.execute }), /INVALID_PINNED_PNPM/)
    assert.equal(fake.calls.length, 0)
  }
})
