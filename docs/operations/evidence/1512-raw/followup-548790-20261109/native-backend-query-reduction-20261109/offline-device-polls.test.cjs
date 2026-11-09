const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

// Actual handler, ORM getter, schema and authority-reader source bodies are
// evaluated with a fake PostgreSQL boundary. This measures only the post-auth
// business read; the real route admission and revocation races require PG17.
const root = path.join(__dirname, 'checkout')
const localRequire = createRequire(path.join(root, 'package.json'))
const ts = localRequire('typescript')
const orm = localRequire('drizzle-orm')
const { drizzle } = localRequire('drizzle-orm/node-postgres')
const source = file => readFileSync(path.join(root, file), 'utf8')
function evaluate(text, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  const require = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error('Unexpected dependency in offline read probe')
  }
  vm.runInNewContext('(function(require,module,exports){' + compiled + '\n})', globals)(require, module, module.exports)
  return module.exports
}
function selectSource(file, names, extra = () => false) {
  const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true)
  return parsed.statements.filter(statement => ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
    && names.includes(statement.name?.text)) || extra(statement, parsed)).map(statement => statement.getText(parsed)).join('\n')
}
const schema = localRequire('./lib/db/schema.ts')
const authority = new AsyncLocalStorage()
const { readUnderAuthority } = evaluate(selectSource('lib/db/device-scope.ts', ['DeviceAuthorityRevoked', 'readUnderAuthority']), {}, { authority })
const owner = 'synthetic-poll-owner', device = '00000000-0000-4000-8000-000000000011'
const caller = { userId: owner, tokenId: '00000000-0000-4000-8000-000000000012' }

for (const kind of ['runs', 'repos']) test(kind + ' returns its empty list with one post-auth business read', async t => {
  let calls = 0
  const client = { query: async first => {
    calls++
    const text = typeof first === 'string' ? first : first.text
    if (text.includes('FROM device_tokens WHERE')) return { rows: [{ value: kind === 'runs' ? { runIds: [] } : [] }] }
    if (text.includes('from "devices"')) {
      const row = { id: device, ownerId: owner, enabled: true }
      const fields = [...text.slice(0, text.indexOf(' from ')).matchAll(/"([A-Za-z_][A-Za-z_0-9]*)"/g)].map(match => match[1])
      return { rows: first.rowMode === 'array' ? [fields.map(key => row[key] ?? null)] : [row] }
    }
    if (text.includes('from "agent_runs"') || text.includes('from "device_repos"')) return { rows: [] }
    throw new Error('Unexpected PostgreSQL boundary request')
  } }
  const db = drizzle({ client })
  const getters = evaluate(selectSource('lib/device-link.ts', ['ownsDevice', 'ownedDevice'],
    (statement, parsed) => ts.isVariableStatement(statement) && statement.getText(parsed).includes('getTableColumns(devices)')),
  {}, { db, devices: schema.devices, ...orm })
  const database = { db, readUnderDeviceAuthority: (select, params) => readUnderAuthority(client, select, params) }
  const route = evaluate(source(`app/v1/devices/[deviceId]/${kind}/route.ts`), {
    '@/lib/device-route': { withDeviceRoute: handler => handler },
    'next/server': { NextResponse: Response },
    'drizzle-orm': orm,
    '@/lib/db': database,
    '@/lib/db/schema': schema,
    '@/lib/device-link': { ...getters, authenticateDevice: async () => caller },
    '@/lib/device-repositories': { readRepositoryDaemonSettings() { throw new Error('No settings read for an empty repository list') } },
  })
  const response = await authority.run({ caller }, () => route.GET(new Request(`http://127.0.0.1/v1/devices/${device}/${kind}`), { params: Promise.resolve({ deviceId: device }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), kind === 'runs' ? { runIds: [] } : { repos: [] })
  t.diagnostic(JSON.stringify({ scenario: kind, postAuthBusinessQueries: calls, postgresObserved: false }))
  assert.equal(calls, 1)
})
