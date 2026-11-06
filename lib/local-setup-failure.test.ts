import assert from 'node:assert/strict'
import test from 'node:test'
import { firstRealError, realErrorLines } from './local-setup-failure'

const warnings = [
  'npm warn EBADENGINE Unsupported engine {',
  "npm warn EBADENGINE   package: '@aspectlylabs/mikka@0.0.503',",
  'npm warn EBADENGINE }',
  'npm warn deprecated @opentelemetry/sdk-trace-base@2.12.0: Use @opentelemetry/sdk-trace package',
  '(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
  '(Use `node --trace-deprecation ...` to show where the warning was created)',
].join('\n')

test('npm warnings and deprecations never become the summary', () => {
  const stderr = `${warnings}\nnpm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@aspectlylabs\nnpm error errno -13\nnpm error A complete log of this run can be found in: /Users/a/.npm/_logs/x.log\n`
  assert.equal(firstRealError(stderr), 'code EACCES\nsyscall mkdir\npath /usr/local/lib/node_modules/@aspectlylabs')
  assert.equal(firstRealError(warnings), '')
  assert.deepEqual(realErrorLines(warnings), [])
})

test('text that is not npm output keeps its first real lines', () => {
  assert.equal(firstRealError('Node.js >=24 required'), 'Node.js >=24 required')
  assert.equal(firstRealError(`${warnings}\nzsh:1: command not found: mikka`), 'zsh:1: command not found: mikka')
  assert.equal(firstRealError('Device did not come online within 30 seconds'), 'Device did not come online within 30 seconds')
})
