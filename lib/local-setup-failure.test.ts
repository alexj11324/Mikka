import assert from 'node:assert/strict'
import test from 'node:test'
import { CodedError } from '@mikka/protocol/coded-error'
import { CommandFailed, classifySetupFailure, firstRealError, setupError } from './local-setup-failure'

const warnings = [
  'npm warn EBADENGINE Unsupported engine {',
  "npm warn EBADENGINE   package: '@aspectlylabs/mikka@0.0.503',",
  'npm warn EBADENGINE }',
  'npm warn deprecated @opentelemetry/sdk-trace-base@2.12.0: Use @opentelemetry/sdk-trace package',
  '(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
  '(Use `node --trace-deprecation ...` to show where the warning was created)',
].join('\n')

test('npm warnings and deprecations never become the reason', () => {
  const stderr = `${warnings}\nnpm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@aspectlylabs\nnpm error errno -13\nnpm error A complete log of this run can be found in: /Users/a/.npm/_logs/x.log\n`
  assert.equal(firstRealError(stderr), 'code EACCES\nsyscall mkdir\npath /usr/local/lib/node_modules/@aspectlylabs')
  const failure = classifySetupFailure(new CommandFailed(243, stderr))
  assert.equal(failure.detail, 'npm_permission')
  assert.deepEqual(failure.values, { path: '/usr/local/lib/node_modules/@aspectlylabs' })
  assert.equal(failure.log, stderr.trim())
  assert.equal(firstRealError(warnings), '')
})

test('the Node check names the version and executable the login shell found', () => {
  const tooOld = classifySetupFailure(new CommandFailed(1, 'Node.js >=24 required (found v22.11.0 at /opt/homebrew/Cellar/node@22/22.11.0/bin/node)\n'))
  assert.equal(tooOld.detail, 'node_too_old')
  assert.deepEqual(tooOld.values, { required: '24', found: '22', path: '/opt/homebrew/Cellar/node@22/22.11.0/bin/node' })
  assert.equal(classifySetupFailure(new CommandFailed(1, 'Node.js >=24 required (node not found)')).detail, 'node_missing')
  assert.equal(classifySetupFailure(new CommandFailed(1, 'Node.js >=24 required')).detail, 'node_missing')
})

test('known npm, network, PATH and service failures each get their own detail', () => {
  const cases: [string, string, Record<string, string>?][] = [
    [`${warnings}\nnpm error code ENOTEMPTY\nnpm error syscall rename\nnpm error path /opt/homebrew/lib/node_modules/@aspectlylabs/mikka\nnpm error dest /opt/homebrew/lib/node_modules/@aspectlylabs/.mikka-AbCd\nnpm error ENOTEMPTY: directory not empty, rename '/opt/homebrew/lib/node_modules/@aspectlylabs/mikka' -> '/opt/homebrew/lib/node_modules/@aspectlylabs/.mikka-AbCd'`, 'npm_directory_not_empty', { path: '/opt/homebrew/lib/node_modules/@aspectlylabs/mikka' }],
    ['npm error code E404\nnpm error 404 Not Found', 'npm_package_not_found'],
    ['npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed', 'network', { code: 'ENOTFOUND' }],
    ['zsh:1: command not found: mikka', 'command_missing'],
    ['Bootstrap failed: 5: Input/output error', 'service_failed'],
    ['Linux or macOS required', 'unsupported_os'],
    ['something else entirely', 'other'],
  ]
  for (const [stderr, detail, values] of cases) {
    const failure = classifySetupFailure(new CommandFailed(1, stderr))
    assert.equal(failure.detail, detail, stderr)
    if (values) assert.deepEqual(failure.values, values)
  }
})

test("main's own failures keep their meaning and the coded error keeps the cause", () => {
  assert.equal(classifySetupFailure(new Error('Device did not come online within 30 seconds')).detail, 'online_timeout')
  assert.equal(classifySetupFailure(new Error('SSH operation timed out')).detail, 'timeout')
  assert.equal(classifySetupFailure(new Error('Device does not belong to the signed-in account')).detail, 'owner_mismatch')
  const cause = new CommandFailed(1, 'npm error code E404')
  const { error, failure } = setupError(cause)
  assert.ok(error instanceof CodedError)
  assert.equal(error.message, 'desktop_local_setup_failed (npm_package_not_found)')
  assert.equal(error.cause, cause)
  assert.equal(failure.summary, 'code E404')
  assert.equal(new CommandFailed(1, `${warnings}\nnpm error code E404`).message, 'code E404')
})
