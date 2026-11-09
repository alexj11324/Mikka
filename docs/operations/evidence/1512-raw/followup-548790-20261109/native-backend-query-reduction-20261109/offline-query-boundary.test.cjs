const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

// This local probe evaluates the actual source functions against the query
// boundary only. It cannot prove PostgreSQL atomicity, locks or revocation.
// The paired real-PostgreSQL suite is the separate integration gate.
const checkout = path.join(__dirname, 'checkout')
const localRequire = createRequire(path.join(checkout, 'package.json'))
const ts = localRequire('typescript')
function evaluate(source, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  const require = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    if (name === 'server-only') return {}
    if (name === 'node:crypto') return localRequire(name)
    throw new Error('Unexpected dependency in offline probe')
  }
  vm.runInNewContext('(function(require,module,exports){' + compiled + '\n})', globals)(require, module, module.exports)
  return module.exports
}
const linkSource = readFileSync(path.join(checkout, 'lib/device-link.ts'), 'utf8')
const parsed = ts.createSourceFile('device-link.ts', linkSource, ts.ScriptTarget.Latest, true)
const cryptoFunctions = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && ['hashDeviceToken', 'newDeviceToken'].includes(statement.name?.text)).map(statement => statement.getText(parsed)).join('\n')
assert.equal(parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && ['hashDeviceToken', 'newDeviceToken'].includes(statement.name?.text)).length, 2)
const link = evaluate(cryptoFunctions, {}, { createHash, randomBytes })
const source = relative => readFileSync(path.join(checkout, relative), 'utf8')

test('a valid enrollment performs one query at the database boundary', async t => {
  let calls = 0
  const query = async text => {
    calls++
    if (/^\s*DELETE\b/.test(text)) return { rows: [{ userId: 'synthetic-owner' }] }
    if (/^\s*WITH\b/.test(text)) return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }] }
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  const { consumeDeviceEnrollment } = evaluate(source('lib/device-enrollment.ts'), { '@/lib/db': { pool }, '@/lib/device-link': link })
  const credential = await consumeDeviceEnrollment('synthetic-local-grant')
  assert.ok(typeof credential === 'string' && /^orv_[A-Za-z0-9_-]{43}$/.test(credential), 'the caller receives an ordinary device credential')
  t.diagnostic(JSON.stringify({ scenario: 'valid-enrollment', queryCalls: calls, postgresObserved: false }))
  assert.equal(calls, 1)
})

test('reading pending commands without receipts performs one query at the database boundary', async t => {
  let calls = 0
  const expected = [{ id: '00000000-0000-4000-8000-000000000002', kind: 'restart' }]
  const query = async text => {
    calls++
    if (/^\s*SELECT "removedAt"/.test(text)) return { rows: [{ removedAt: null }] }
    if (/^\s*SELECT\b/.test(text)) return { rows: expected }
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  const { pendingDeviceCommands } = evaluate(source('lib/device-management.ts'), { '@/lib/db': { pool }, '@/lib/device-gateway-notify': { notifyDeviceWork() { throw new Error('No notification is expected for a read') } } })
  assert.deepEqual(await pendingDeviceCommands('00000000-0000-4000-8000-000000000003', []), expected)
  t.diagnostic(JSON.stringify({ scenario: 'pending-without-receipts', queryCalls: calls, postgresObserved: false }))
  assert.equal(calls, 1)
})
