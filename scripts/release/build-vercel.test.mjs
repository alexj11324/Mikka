import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REQUIRED, buildEnvironment, buildEnvironmentValues } from './web-deploy.mjs'
import { directDatabaseURL } from '../postgres-connection.mjs'
import { buildFailureEvidence, productionBuildEnvironment } from './build-vercel.mjs'

test('official failure evidence retains codes and digests without private source or credentials', () => {
  const log = Buffer.from('> mikka@1 build /work\n> node scripts/build-subscription-worker.mjs && pnpm generate:agent-ui\n> mikka@1 build:app /work\n> mikka@1 typecheck /work\nsecret-fixture-value private-renderer-source\n  at file:///work/scripts/migrate.mjs:84:11\n code: \'22023\'\n')
  const result = buildFailureEvidence({ result: { status: 1, signal: null, error: Object.assign(new Error('secret-fixture-value'), { code: 'ENOSPC' }) },
    sourceSha: 'a'.repeat(40), overlaySha: 'b'.repeat(40), log })
  assert.equal(result.lastObservedPhase, 'migrate')
  assert.equal(result.databaseCode, '22023')
  assert.equal(result.processErrorCode, 'ENOSPC')
  assert.equal(result.observedSystemCode, null)
  assert.equal(result.logBytes, log.length)
  assert.match(result.logSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(result).includes('secret-fixture-value'), false)
  assert.equal(JSON.stringify(result).includes('private-renderer-source'), false)
  assert.equal(JSON.stringify(result).includes('/work'), false)
})

test('child failure observes a closed system-code candidate without a spawn error or private details', () => {
  for (const line of [
    "  code: 'ENOSPC', path: '/private/renderer-source'",
    '  code: "ENOSPC", private-marker',
    'Error: ENOSPC: no space left on device, write /private/renderer-source',
  ]) {
    const log = Buffer.from('private-marker secret-fixture-value\n' + line + '\n')
    const value = buildFailureEvidence({ result: { status: 1, signal: null },
      sourceSha: 'a'.repeat(40), overlaySha: 'b'.repeat(40), log })
    assert.equal(value.exitStatus, 1)
    assert.equal(value.processErrorCode, null)
    assert.equal(value.observedSystemCode, 'ENOSPC')
    assert.equal(value.lastObservedPhase, 'unknown')
    for (const marker of ['private-marker', 'secret-fixture-value', '/private/', 'renderer-source', 'no space left']) {
      assert.equal(JSON.stringify(value).includes(marker), false)
    }
  }
})

test('unrecognized or unstructured child text does not become an observed system code', () => {
  for (const line of [
    "code: 'PRIVATE_MARKER'",
    'Error: PRIVATE_MARKER: secret-fixture-value',
    "code: 'ENOSPC_PRIVATE_MARKER'",
    'Error: ENOSPC_PRIVATE_MARKER: secret-fixture-value',
    'private-marker ENOSPC secret-fixture-value',
  ]) {
    const value = buildFailureEvidence({ result: { status: 1, signal: null },
      log: Buffer.from(line) })
    assert.equal(value.observedSystemCode, null)
    assert.equal(value.processErrorCode, null)
    assert.equal(value.lastObservedPhase, 'unknown')
    assert.equal(JSON.stringify(value).includes('PRIVATE_MARKER'), false)
    assert.equal(JSON.stringify(value).includes('secret-fixture-value'), false)
  }
})

test('compiler observations retain only bounded diagnostic codes and fixed public commands', () => {
  const log = Buffer.from([
    '> tsrs --noEmit && tsrs --noEmit -p apps/api/tsconfig.json && pnpm --filter @mikka/frontend typecheck',
    '/private/renderer.tsx(1,1): error TS2322: private-source secret-fixture-value',
    'error TS2307: private module', 'error TS2322: repeated private message',
    'error TS_PRIVATE: secret-fixture-value', 'error TS123456: private message',
  ].join('\n'))
  const result = buildFailureEvidence({ result: { status: 1 }, log })
  assert.equal(result.lastTypecheckCommand, 'root-and-api')
  assert.deepEqual(result.typescriptCodes, ['TS2307', 'TS2322'])
  const frontend = buildFailureEvidence({ result: { status: 1 }, log: Buffer.from(log + '\n> tsc --noEmit -p tsconfig.json\n') })
  assert.equal(frontend.lastTypecheckCommand, 'frontend')
  for (const marker of ['private', 'renderer', 'secret-fixture-value', 'TS_PRIVATE', 'TS123456']) assert.equal(JSON.stringify(result).includes(marker), false)
  const bounded = buildFailureEvidence({ result: { status: 1 }, log: Buffer.from(Array.from({ length: 30 }, (_, n) => `error TS${1000 + n}: private`).join('\n')) })
  assert.equal(bounded.typescriptCodes.length, 16)
})


test('real TypeScript colored diagnostics retain codes and raw log digests', async () => {
  const { default: ts } = await import('typescript')
  const { createHash } = await import('node:crypto')
  assert.equal(ts.version, '5.9.3')
  const fileName = '/private/colored-diagnostic-fixture.ts'
  const source = 'const privateFixtureValue: string = 1\n'
  const options = { noEmit: true, noLib: true, strict: true, target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name, version) => name === fileName ? ts.createSourceFile(name, source, version, true) : undefined
  host.readFile = name => name === fileName ? source : undefined
  host.fileExists = name => name === fileName
  const program = ts.createProgram([fileName], options, host)
  const diagnostics = program.getSemanticDiagnostics(program.getSourceFile(fileName))
  assert.deepEqual(diagnostics.map(value => value.code), [2322])
  const colored = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => '/private',
    getCanonicalFileName: name => name,
    getNewLine: () => '\n',
  })
  assert.equal(colored.includes('\x1b['), true)
  const log = Buffer.from('\x1b[36m> tsrs --noEmit && tsrs --noEmit -p apps/api/tsconfig.json && pnpm --filter @mikka/frontend typecheck\x1b[0m\n'
    + colored + '\n\x1b[36mmigrate: starting\x1b[0m\n')
  const original = Buffer.from(log)
  const result = buildFailureEvidence({ result: { status: 1 }, log })
  assert.deepEqual(result.typescriptCodes, ['TS2322'])
  assert.equal(result.lastTypecheckCommand, 'root-and-api')
  assert.equal(result.lastObservedPhase, 'migrate')
  assert.equal(result.logBytes, original.length)
  assert.equal(result.logSha256, createHash('sha256').update(original).digest('hex'))
  assert.deepEqual(log, original)
  for (const marker of ['private', 'colored-diagnostic-fixture', 'privateFixtureValue', '\x1b['])
    assert.equal(JSON.stringify(result).includes(marker), false)
})

test('migration entry is observed without requiring an error stack or claiming SQL execution', () => {
  const result = buildFailureEvidence({ result: { status: 1 }, log: Buffer.from('> mikka@1 typecheck /work\nmigrate: starting\nprivate guard error\n') })
  assert.equal(result.lastObservedPhase, 'migrate')
  assert.equal(result.lastTypecheckCommand, null)
  assert.deepEqual(result.typescriptCodes, [])
  assert.equal(JSON.stringify(result).includes('private guard'), false)
  const unknown = buildFailureEvidence({ result: { status: 1 }, log: Buffer.from('private migrate: starting\n> private tsc --noEmit -p tsconfig.json') })
  assert.equal(unknown.lastObservedPhase, 'unknown')
  assert.equal(unknown.lastTypecheckCommand, null)
})

test('unknown failure details remain unknown and a kill signal is not labeled as OOM', () => {
  const value = buildFailureEvidence({ result: { status: null, signal: 'SIGKILL', error: { code: 'PRIVATE_VALUE' } },
    sourceSha: 'not-a-source', overlaySha: 'private-value', log: Buffer.from('private typecheck\n code: \'PRIVATE_VALUE\'\n') })
  assert.equal(value.signal, 'SIGKILL')
  assert.equal(value.exitStatus, null)
  assert.equal(value.lastObservedPhase, 'unknown')
  for (const key of ['sourceSha', 'overlaySha', 'processErrorCode', 'observedSystemCode', 'databaseCode', 'networkCode']) assert.equal(value[key], null)
  assert.equal(JSON.stringify(value).includes('OOM'), false)
  const absent = buildFailureEvidence({ result: { status: 300, signal: 'SECRET' } })
  assert.equal(absent.logBytes, null)
  assert.equal(absent.logSha256, null)
  assert.equal(absent.exitStatus, null)
  assert.equal(absent.signal, null)
})

const sourceSha = 'a'.repeat(40)
const env = { GITHUB_SHA: sourceSha, VERCEL_GIT_COMMIT_SHA: sourceSha, MIKKA_DEPLOYMENT_ID: 'aaaaaaaaaaaa-123-1' }
const databases = { MIKKA_DATABASE_URL: 'postgresql://localhost/application_e2e', DATABASE_URL: 'postgresql://localhost/workspace_e2e' }
const text = ['VERCEL_ENV="production"', ...REQUIRED.map(key => `${key}=${JSON.stringify(databases[key] ?? `fixture-${key}`)}`)].join('\n')

test('production build binds the exact source and deployment without acceptance credentials', () => {
  const result = productionBuildEnvironment({ text, sourceSha, nodeVersion: 'v24.22.1', env: { ...env,
    VERCEL_GIT_PROVIDER: 'conflicting-provider', VERCEL_GIT_REPO_OWNER: 'conflicting-owner', VERCEL_GIT_REPO_SLUG: 'conflicting-repo',
    MIKKA_TEST_DEPLOYMENT_SHA: sourceSha, MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_TEST_ENVIRONMENT_FILE: 'fixture-only' } })
  assert.equal(result.NITRO_PRESET, 'vercel')
  assert.equal(result.NEXT_PUBLIC_MIKKA_BUILD, sourceSha)
  assert.equal(result.MIKKA_DEPLOYMENT_ID, env.MIKKA_DEPLOYMENT_ID)
  assert.equal(result.VERCEL_GIT_PROVIDER, 'github')
  assert.equal(result.VERCEL_GIT_REPO_OWNER, 'alexj11324')
  assert.equal(result.VERCEL_GIT_REPO_SLUG, 'Mikka')
  assert.equal(result.MIKKA_DATABASE_URL, databases.MIKKA_DATABASE_URL)
  for (const key of ['MIKKA_TEST_DEPLOYMENT_SHA', 'MIKKA_LOCAL_TEST_ACCOUNTS', 'MIKKA_TEST_ENVIRONMENT_FILE']) assert.equal(result[key], undefined)
})

test('production preflight rejects stale source, missing values and an unbound deployment', () => {
  const prepare = overrides => productionBuildEnvironment({ text, sourceSha, env, nodeVersion: 'v24.22.1', ...overrides })
  assert.throws(() => prepare({ sourceSha: 'b'.repeat(40) }), /sourceMismatch/)
  assert.throws(() => prepare({ env: { ...env, VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) } }), /sourceMismatch/)
  assert.throws(() => prepare({ text: text.replace('fixture-BETTER_AUTH_SECRET', '') }), /missing:BETTER_AUTH_SECRET/)
  assert.throws(() => prepare({ text: text.replace('"production"', '"preview"') }), /productionEnvironmentRequired/)
  assert.throws(() => prepare({ env: { ...env, MIKKA_DEPLOYMENT_ID: '' } }), /deploymentIdRequired/)
  assert.throws(() => prepare({ nodeVersion: 'v22.23.4' }), /node24Required/)
})

test('the filled build file preserves JSON-escaped connection and auth values byte for byte', () => {
  const plain = 'postgresql://fixture:plain@ep-fixture-pooler.us-east-2.aws.neon.tech/app?sslmode=require'
  const cases = [
    ['plain', plain],
    ['quoted password', plain.replace('plain', 'quoted"password')],
    ['backslash password', plain.replace('plain', 'back\\slash')],
    ['dollar password', plain.replace('plain', 'dollar$password')],
    ['escaped dollar password', plain.replace('plain', 'back\\$password')],
    ['leading CR', '\r' + plain],
    ['trailing LF', plain + '\n'],
    ['literal backslash n', plain.replace('plain', 'literal\\npassword')],
  ]
  const authSecret = 'fixture\r\n"quoted"\\literal\\$cash'
  const withheld = text.replace(databases.MIKKA_DATABASE_URL, '')
    .replace(databases.DATABASE_URL, '').replace('fixture-BETTER_AUTH_SECRET', '')
  const observed = cases.map(([name, connection]) => {
    const values = { ...env, MIKKA_DATABASE_URL: connection,
      DATABASE_URL: connection.replace('/app?', '/workspace?'), BETTER_AUTH_SECRET: authSecret }
    // The production workflow first fills the file, then the direct builder
    // reads that already-filled file. Neither pass may reinterpret credentials.
    const filled = buildEnvironment(withheld, values)
    const result = productionBuildEnvironment({ text: filled, sourceSha, env, nodeVersion: 'v24.22.1' })
    let directUsable = false
    try {
      directUsable = ['MIKKA_DATABASE_URL', 'DATABASE_URL'].every(key =>
        new URL(directDatabaseURL(result[key])).password === new URL(values[key]).password)
    } catch { /* Report only the closed observation, never the connection value. */ }
    return { name, applicationUnchanged: result.MIKKA_DATABASE_URL === values.MIKKA_DATABASE_URL,
      workspaceUnchanged: result.DATABASE_URL === values.DATABASE_URL,
      authUnchanged: result.BETTER_AUTH_SECRET === authSecret, directUsable }
  })
  assert.deepEqual(observed, cases.map(([name]) => ({ name, applicationUnchanged: true,
    workspaceUnchanged: true, authUnchanged: true, directUsable: true })))
})

test('the codec does not repair or dequote an originally invalid database value', () => {
  const invalid = '"postgresql://fixture:password@database.invalid/app"'
  const withheld = text.replace(databases.MIKKA_DATABASE_URL, '')
  const values = { ...env, MIKKA_DATABASE_URL: invalid }
  const filled = buildEnvironment(withheld, values)
  assert.equal(buildEnvironmentValues(filled, values).MIKKA_DATABASE_URL === invalid, true)
  assert.throws(() => productionBuildEnvironment({ text: filled, sourceSha, env: values, nodeVersion: 'v24.22.1' }),
    { message: 'webDeploy:databaseConnectionUrlInvalid:MIKKA_DATABASE_URL' })
  assert.throws(() => directDatabaseURL(invalid), /DATABASE_CONNECTION_URL_INVALID/)
})

test('non-empty job values retain the legacy Vercel precedence over the filled file', () => {
  const job = { ...env, MIKKA_DATABASE_URL: 'postgresql://localhost/job_application_e2e',
    DATABASE_URL: 'postgresql://localhost/job_workspace_e2e', BETTER_AUTH_SECRET: 'fixture"\r\n\\$literal' }
  const filled = buildEnvironment(text, job)
  const result = productionBuildEnvironment({ text: filled, sourceSha, env: job })
  for (const key of ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'BETTER_AUTH_SECRET']) {
    assert.equal(result[key] === job[key], true)
  }
  assert.equal(result.VERCEL_GIT_COMMIT_SHA, sourceSha)
  assert.equal(result.VERCEL_ENV, 'production')
})

test('empty or absent job values fall back to the decoded file without URL normalization', () => {
  const application = 'postgresql://ep-fixture-pooler.us-east-2.aws.neon.tech/app?sslmode=require'
  const file = text.replace(databases.MIKKA_DATABASE_URL, application)
  for (const value of [undefined, '']) {
    const result = productionBuildEnvironment({ text: buildEnvironment(file, env), sourceSha,
      env: { ...env, MIKKA_DATABASE_URL: value, DATABASE_URL: value, BETTER_AUTH_SECRET: value } })
    assert.equal(result.MIKKA_DATABASE_URL === application, true)
    assert.equal(result.DATABASE_URL === databases.DATABASE_URL, true)
    assert.equal(result.BETTER_AUTH_SECRET, 'fixture-BETTER_AUTH_SECRET')
    assert.notEqual(directDatabaseURL(result.MIKKA_DATABASE_URL), result.MIKKA_DATABASE_URL)
  }
})

test('both selected migration targets fail early with only a key and fixed code', () => {
  for (const key of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    for (const invalid of ['not-a-url', '"postgresql://localhost/fixture_e2e"', 'https://localhost/fixture_e2e']) {
      assert.throws(() => productionBuildEnvironment({ text, sourceSha, env: { ...env, [key]: invalid } }),
        { message: 'webDeploy:databaseConnectionUrlInvalid:' + key })
    }
  }
})


test('a real deletion-fence SQLSTATE is retained without exposing its account or database text', () => {
  const log = Buffer.from("migrate: starting\nerror: private-account-fixture account_deletion_pending\n  code: '55000',\n")
  const evidence = buildFailureEvidence({ result: { status: 1 }, sourceSha: 'a'.repeat(40), overlaySha: 'b'.repeat(40), log })
  assert.equal(evidence.lastObservedPhase, 'migrate')
  assert.equal(evidence.databaseCode, '55000')
  assert.equal(JSON.stringify(evidence).includes('private-account-fixture'), false)
  assert.equal(JSON.stringify(evidence).includes('account_deletion_pending'), false)
})
