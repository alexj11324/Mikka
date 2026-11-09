import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [operation, phase] = process.argv.slice(2)
assert.ok(['capture', 'run'].includes(operation))
assert.ok(['red', 'green'].includes(phase))
const root = process.cwd()
const state = join(process.env.RUNNER_TEMP, 'issue1512-pg')
const originals = join(state, 'originals')
mkdirSync(originals, { recursive: true })
const manifestBytes = readFileSync(join(state, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 }).trim()
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
const fixed = phase === 'red' ? manifest.before : manifest.after
const evidence = {
  schema: 'issue1512-isolated-pg17-v1', phase,
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  controlSha: process.env.GITHUB_SHA,
  before: manifest.before, after: manifest.after,
  manifestSha256: hash(manifestBytes),
  driverSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  startedAt: new Date().toISOString(), commands: [],
}
function persist() {
  writeFileSync(join(originals, phase + '-receipt.json'), JSON.stringify(evidence, null, 2) + '\n')
}
function verifyAdmission() {
  assert.equal(manifest.enabled, true, 'Unbound/closed regression manifest')
  assert.equal(process.env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/' + manifest.opsBranch)
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'No retry-to-green')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.platform, 'linux')
  assert.ok(Date.now() <= Date.parse(manifest.expiresAt), 'Admission expired')
  for (const side of [manifest.before, manifest.after]) {
    for (const field of ['sha', 'tree', 'sourceBlob', 'testBlob']) {
      assert.match(side[field], /^[0-9a-f]{40}$/, field + ' must be an immutable Git object')
    }
  }
  assert.equal(manifest.before.sha, 'e0934eb89f972d44ef6cffec6e27c16b4ed203bf')
  assert.equal(evidence.driverSha256, manifest.driverSha256)
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH))
  assert.equal(event.after, process.env.GITHUB_SHA)
  assert.equal(event.head_commit?.message, manifest.admissionMessage)
  for (const name of ['INFISICAL_TOKEN', 'INFISICAL_CLIENT_SECRET', 'POSTHOG_API_KEY', 'NEXT_PUBLIC_POSTHOG_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VERCEL_TOKEN', 'NEON_API_KEY', 'RESEND_API_KEY']) {
    assert.ok(!process.env[name], 'Unexpected external credential: ' + name)
  }
}
verifyAdmission()
if (operation === 'capture') {
  assert.equal(git(['rev-parse', 'HEAD']), process.env.GITHUB_SHA)
  assert.equal(gitBlob(readFileSync('tests/coordinator-bot.db.test.ts')), manifest.after.testBlob)
  copyFileSync('tests/coordinator-bot.db.test.ts', join(state, 'candidate-test.ts'))
  const control = {
    controlSha: git(['rev-parse', 'HEAD']), controlTree: git(['rev-parse', 'HEAD^{tree}']),
    workflowBlob: git(['rev-parse', 'HEAD:.github/workflows/issue1512-backfill-pg.yml']),
    manifestSha256: evidence.manifestSha256, driverSha256: evidence.driverSha256,
    phase, capturedAt: new Date().toISOString(),
  }
  writeFileSync(join(state, 'control.json'), JSON.stringify(control) + '\n')
  console.log('ISSUE1512_PG_CONTROL ' + JSON.stringify(control))
} else {
  const control = JSON.parse(readFileSync(join(state, 'control.json')))
  assert.equal(control.controlSha, process.env.GITHUB_SHA)
  assert.equal(control.manifestSha256, evidence.manifestSha256)
  assert.equal(control.driverSha256, evidence.driverSha256)
  evidence.control = control
  assert.equal(git(['rev-parse', 'HEAD']), fixed.sha)
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), fixed.tree)
  assert.equal(git(['rev-parse', 'HEAD:lib/coordinator/coordinator-bot.ts']), fixed.sourceBlob)
  assert.equal(gitBlob(readFileSync('lib/coordinator/coordinator-bot.ts')), fixed.sourceBlob)
  assert.equal(git(['rev-parse', 'HEAD:tests/coordinator-bot.db.test.ts']), fixed.testBlob)
  if (phase === 'red') copyFileSync(join(state, 'candidate-test.ts'), 'tests/coordinator-bot.db.test.ts')
  assert.equal(gitBlob(readFileSync('tests/coordinator-bot.db.test.ts')), manifest.after.testBlob)
  assert.deepEqual(git(['diff', '--name-only']).split('\n').filter(Boolean), phase === 'red' ? ['tests/coordinator-bot.db.test.ts'] : [])
  assert.equal(git(['diff', '--cached', '--name-only']), '')
  for (const [path, blob] of Object.entries(manifest.unchangedBlobs)) {
    assert.equal(git(['rev-parse', 'HEAD:' + path]), blob, 'Canonical source binding: ' + path)
    assert.equal(gitBlob(readFileSync(path)), blob, 'Canonical file content: ' + path)
  }
  assert.match(process.version, /^v24\./)
  assert.equal(execFileSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30000 }).trim(), '10.34.3')
  const url = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_e2e'
  for (const name of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.equal(process.env[name], url)
  assert.ok(!process.env.ORVILO_DATABASE_URL)
  assert.equal(process.env.BETTER_AUTH_URL, 'http://localhost:3100')
  assert.ok(process.env.BETTER_AUTH_SECRET?.length >= 32)
  const envFile = join(state, phase + '-environment.json')
  assert.equal(existsSync(envFile), false, 'No previous environment may be adopted')
  const env = {
    ...process.env, MIKKA_TEST_DEPLOYMENT_SHA: fixed.sha,
    MIKKA_TEST_ENVIRONMENT_FILE: envFile, REQUIRE_DB: '1', CI: 'true',
    MIKKA_TEST_DB_PORT: '5432', RUN_DISPATCH_DB_TESTS: '1',
    FACTORY_MONITOR_TEST_URL: url, CREDENTIAL_TEST_RETAIN_RESOURCES: '1',
  }
  delete env.DB_TEST_SHARD
  delete env.DB_TEST_SELECTED
  delete env.DB_TEST_EXPECTED
  const { Pool } = createRequire(join(root, 'package.json'))('pg')
  const { parseSummary, checkSummary, validateTarget } = await import(pathToFileURL(join(root, 'scripts/run-db-tests.mjs')))
  validateTarget(env)
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  try {
    const identity = (await pool.query('SELECT current_database() AS database, session_user AS role, current_setting(\'server_version_num\') AS version, inet_server_port() AS port')).rows[0]
    assert.deepEqual({ database: identity.database, role: identity.role, port: identity.port }, { database: 'mikka_e2e', role: 'e2e', port: 5432 })
    assert.match(identity.version, /^17/)
    assert.equal((await pool.query("SELECT to_regclass('public.schema_migrations') AS relation")).rows[0].relation, null, 'Each job must begin with a fresh DB')
    evidence.database = identity
    evidence.node = process.version
    evidence.pnpm = '10.34.3'
  } finally { await pool.end() }
  persist()
  async function command(label, executable, args, extraEnv = {}, timeoutMs = 240000) {
    const startedAt = new Date().toISOString()
    console.log('ISSUE1512_PG_COMMAND_START ' + JSON.stringify({ phase, label, executable, args, startedAt, timeoutMs }))
    const result = await new Promise(resolvePromise => {
      const child = spawn(executable, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      const stdout = [], stderr = []
      let timedOut = false
      let spawnError = null
      const timer = setTimeout(() => {
        timedOut = true
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }, timeoutMs)
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.on('error', error => { spawnError = error.message })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolvePromise({ code, signal, timedOut, spawnError, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
      })
    })
    const entry = { label, executable, args, startedAt, finishedAt: new Date().toISOString(), code: result.code, signal: result.signal, timedOut: result.timedOut, spawnError: result.spawnError }
    for (const stream of ['stdout', 'stderr']) {
      const filename = phase + '-' + label + '-' + stream + '.log'
      writeFileSync(join(originals, filename), result[stream])
      entry[stream] = { file: filename, bytes: result[stream].length, sha256: hash(result[stream]) }
      console.log('ISSUE1512_PG_ORIGINAL_BEGIN ' + JSON.stringify({ phase, label, stream, ...entry[stream] }))
      const encoded = result[stream].toString('base64')
      for (let offset = 0; offset < encoded.length; offset += 12000) console.log('ISSUE1512_PG_ORIGINAL_CHUNK ' + encoded.slice(offset, offset + 12000))
      console.log('ISSUE1512_PG_ORIGINAL_END ' + JSON.stringify({ phase, label, stream }))
    }
    evidence.commands.push(entry)
    persist()
    console.log('ISSUE1512_PG_COMMAND_END ' + JSON.stringify(entry))
    assert.equal(result.timedOut, false, label + ' timed out (infra failure)')
    assert.equal(result.spawnError, null, label + ' could not start (infra failure)')
    assert.equal(result.signal, null, label + ' terminated by signal (infra failure)')
    return { ...result, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
  }
  function passing(label, result, requireSummary = false) {
    assert.equal(result.code, 0, label + ' failed')
    if (requireSummary) assert.equal(checkSummary(label, result.code, parseSummary(result.stdout + '\n' + result.stderr)), null)
  }
  function failures(tap) {
    const found = []
    const pattern = /^([ ]*)not ok \d+ - (.+)$/gm
    for (const match of tap.matchAll(pattern)) {
      const remaining = tap.slice(match.index + match[0].length)
      const end = new RegExp('^' + match[1] + '  \\.\\.\\.\\s*$', 'm').exec(remaining)
      assert.ok(end, 'Every failure must have complete TAP diagnostics')
      found.push({ name: match[2], diagnostic: remaining.slice(0, end.index + end[0].length) })
    }
    return found
  }
  try {
    passing('migration-bootstrap', await command('migration-bootstrap', process.execPath, ['--experimental-strip-types', '--test', 'tests/migrate-empty-db.test.mjs'], { MIGRATION_BOOTSTRAP_CI: '1' }), true)
    passing('e2e-setup', await command('e2e-setup', 'pnpm', ['test:e2e:setup']))
    passing('environment-bind', await command('environment-bind', process.execPath, ['scripts/test-accounts/bootstrap.mjs', '--output', envFile]))
    if (phase === 'red') {
      const result = await command('coordinator-red', process.execPath, [
        '--test-reporter=tap', '--experimental-test-module-mocks', '--test-force-exit',
        '--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test',
        'tests/coordinator-bot.db.test.ts',
      ])
      assert.notEqual(result.code, 0, 'Old source must fail the new regression assertions')
      const totals = parseSummary(result.stdout + '\n' + result.stderr)
      assert.ok(totals.tests >= manifest.minimumRedTests, 'The existing Coordinator test file must run')
      for (const key of ['skipped', 'todo', 'cancelled']) assert.equal(totals[key] ?? 0, 0, key + ' is forbidden')
      assert.equal(totals.pass + totals.fail, totals.tests)
      const records = failures(result.stdout)
      const leaves = records.filter(record => !/failureType:\s*['"]?subtestsFailed/.test(record.diagnostic))
      const parents = records.filter(record => /failureType:\s*['"]?subtestsFailed/.test(record.diagnostic))
      assert.deepEqual(leaves.map(record => record.name).sort(), [...manifest.expectedRedNames].sort(), 'Only the four new empty SQL-count assertions may fail')
      assert.deepEqual(parents.map(record => record.name), ['the Coordinator is an ordinary bot row'])
      for (const record of leaves) {
        assert.match(record.diagnostic, /failureType:\s*['"]?testCodeFailure/)
        assert.match(record.diagnostic, /code:\s*['"]?ERR_ASSERTION/)
        assert.ok(record.diagnostic.replace(/\s+/g, ' ').includes(manifest.expectedRedMessage))
        assert.match(record.diagnostic, /^\s+expected: 1\s*$/m)
        const actual = /^\s+actual: (\d+)\s*$/m.exec(record.diagnostic)
        assert.ok(actual && Number(actual[1]) > 1, 'RED must prove actual redundant SQL')
        record.actualSqlCount = Number(actual[1])
      }
      evidence.verdict = 'EXPECTED_ASSERTION_RED'
      evidence.summary = totals
      evidence.assertionFailures = leaves
    } else {
      const result = await command('coordinator-family-green', 'pnpm', ['test:db'], {
        DB_TEST_SELECTED: JSON.stringify(['test:bot-threads-db']),
        DB_TEST_EXPECTED: manifest.canonicalInventory.join(','),
        DB_TEST_CONCURRENCY: '1',
      }, 360000)
      passing('coordinator-family-green', result, true)
      assert.match(result.stdout, /test:bot-threads-db: OK/)
      assert.match(result.stdout, /Required DB selection: .*"scripts":\["test:bot-threads-db"\]/)
      assert.equal(failures(result.stdout).length, 0)
      for (const name of manifest.expectedRedNames) assert.ok(result.stdout.includes(' - ' + name + '\n'), 'New regression test must run in GREEN: ' + name)
      evidence.verdict = 'COMPLETE_COORDINATOR_FAMILY_GREEN'
      evidence.summary = parseSummary(result.stdout + '\n' + result.stderr)
    }
    evidence.finishedAt = new Date().toISOString()
    persist()
    console.log('ISSUE1512_PG_VERDICT ' + JSON.stringify(evidence))
  } catch (error) {
    evidence.verdict = 'BLOCKED_OR_UNEXPECTED_FAILURE'
    evidence.failure = { name: error.name, message: error.message, code: error.code }
    evidence.finishedAt = new Date().toISOString()
    persist()
    console.error('ISSUE1512_PG_VERDICT ' + JSON.stringify(evidence))
    process.exitCode = 1
  }
}
