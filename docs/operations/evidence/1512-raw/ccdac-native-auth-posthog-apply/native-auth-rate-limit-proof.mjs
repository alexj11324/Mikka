import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Installed, pinned SDK logic only; no application, database, HTTP or browser.
const require = createRequire('/workspace/scratch/812e3b7d6d45/Mikka/package.json')
const sdkDirectory = dirname(require.resolve('better-auth'))
const version = JSON.parse(readFileSync(resolve(sdkDirectory, '../package.json'), 'utf8')).version
assert.equal(version, '1.7.12')
const entry = resolve(sdkDirectory, 'api/rate-limiter/index.mjs')
const { onRequestRateLimit } = await import(pathToFileURL(entry).href)
const operations = []
const context = {
  baseURL: 'https://auth-proof.example.invalid/mikka/api/auth',
  options: { rateLimit: { storage: 'database' }, plugins: [] },
  rateLimit: { enabled: true, storage: 'database', window: 10, max: 100 },
  logger: { warn() {}, error() {} },
  runInBackgroundOrAwait: promise => promise,
  adapter: {
    async findMany({ model }) { assert.equal(model, 'rateLimit'); operations.push('findMany'); return [{ lastRequest: Date.now() - 60_000, count: 1 }] },
    async incrementOne({ model, increment, set }) {
      assert.equal(model, 'rateLimit'); assert.deepEqual(increment, {}); assert.equal(set.count, 1)
      operations.push('incrementOne'); return { count: 1 }
    },
    async deleteMany({ model }) { assert.equal(model, 'rateLimit'); operations.push('deleteMany') },
  },
}
const response = await onRequestRateLimit(new Request(`${context.baseURL}/get-session`), context)
assert.equal(response, undefined)
assert.deepEqual(operations, ['findMany', 'incrementOne', 'deleteMany'])
process.stdout.write(`${JSON.stringify({
  sdk: 'better-auth', version, sdkFileSha256: createHash('sha256').update(readFileSync(entry)).digest('hex'), route: '/api/auth/get-session',
  input: 'expired-rate-limit-window', allowed: response === undefined, adapterOperations: operations,
  adapterOperationsCount: operations.length, databaseQueriesMeasured: false,
  actualNativeAuth3Attribution: 'unproven', productConfigurationChanged: false,
  networkRequests: 0, databaseConnections: 0, providerCalls: 0,
}, null, 2)}\n`)
