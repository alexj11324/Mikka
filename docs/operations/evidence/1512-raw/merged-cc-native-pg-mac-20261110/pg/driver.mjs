import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants, createRequire, enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const operation = process.argv[2]
assert.ok(['prepare', 'start', 'run', 'cleanup'].includes(operation))
const root = process.cwd()
const state = join(process.env.RUNNER_TEMP, 'issue1512-native-pending-pg')
const originals = join(state, 'originals')
mkdirSync(originals, { recursive: true })
const manifestBytes = readFileSync(join(state, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
const git = (args, extraEnv = {}) => execFileSync('git', args, { cwd: root, env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 30000 }).trim()
const docker = (args, timeout = 30000) => execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 16 << 20 }).trim()
const runId = process.env.GITHUB_RUN_ID
const attempt = process.env.GITHUB_RUN_ATTEMPT
assert.match(runId ?? '', /^\d+$/)
assert.match(attempt ?? '', /^\d+$/)
const containerName = 'issue1512-native-pending-pg-' + runId + '-' + attempt
const networkName = 'issue1512-native-pending-net-' + runId + '-' + attempt
const ownership = { 'mikka.issue': '1512', 'mikka.runner': 'native-pending-pg', 'mikka.github-run': runId, 'mikka.github-attempt': attempt, 'mikka.github-sha': process.env.GITHUB_SHA }
const labelArgs = Object.entries(ownership).flatMap(([key, value]) => ['--label', key + '=' + value])
const mask = value => process.stdout.write('::add-mask::' + value + '\n')
const projectedContainer = value => ({
  id: value.Id, name: value.Name, image: value.Config.Image, imageId: value.Image,
  labels: value.Config.Labels, ports: value.HostConfig.PortBindings,
  running: value.State.Running, health: value.State.Health?.Status,
})
function owned(labels) {
  for (const [key, value] of Object.entries(ownership)) assert.equal(labels?.[key], value, 'Resource ownership mismatch: ' + key)
}
function container() {
  const value = JSON.parse(docker(['inspect', containerName]))[0]
  owned(value.Config.Labels)
  assert.equal(value.Config.Image, 'postgres:17')
  assert.deepEqual(value.HostConfig.PortBindings['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: '5432' }])
  return projectedContainer(value)
}
function inspectIfPresent(kind, name) {
  try { return JSON.parse(docker(kind === 'network' ? ['network', 'inspect', name] : kind === 'volume' ? ['volume', 'inspect', name] : ['inspect', name]))[0] }
  catch (error) {
    if (/No such (?:object|container|network|volume)|not found/i.test(String(error.stderr))) return null
    throw error
  }
}
function admission() {
  assert.equal(manifest.enabled, true, 'Closed regression admission')
  assert.equal(process.env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/' + manifest.opsBranch)
  assert.equal(attempt, '1', 'No retry-to-green')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.platform, 'linux')
  assert.equal(process.env.CI, 'true')
  assert.ok(Date.now() <= Date.parse(manifest.expiresAt), 'Admission expired')
  assert.equal(process.version, 'v24.22.1')
  assert.equal(execFileSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30000 }).trim(), '10.34.3')
  assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1')
  assert.equal(process.env.TSX_DISABLE_CACHE, '1')
  assert.equal(process.env.MIKKA_READ_METRICS_TRACE, '1')
  assert.equal(enableCompileCache().status, constants.compileCacheStatus.DISABLED)
  assert.equal(sha256(readFileSync(fileURLToPath(import.meta.url))), manifest.driverSha256)
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH))
  assert.equal(event.after, process.env.GITHUB_SHA)
  assert.equal(event.head_commit?.message, manifest.admissionMessage)
  for (const name of ['INFISICAL_TOKEN', 'INFISICAL_CLIENT_SECRET', 'POSTHOG_API_KEY', 'NEXT_PUBLIC_POSTHOG_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VERCEL_TOKEN', 'NEON_API_KEY', 'RESEND_API_KEY']) assert.ok(!process.env[name], 'Unexpected external credential: ' + name)
  for (const source of [manifest.merge, manifest.red, manifest.green]) for (const key of ['sha', 'tree']) assert.match(source[key], /^[0-9a-f]{40}$/)
  assert.equal(manifest.red.files[manifest.testPath], manifest.green.files[manifest.testPath])
  assert.deepEqual(manifest.expectedRedLeaves.map(row => [row.actual, row.expected]), [[5, 1], [4, 2]])
}
function sourceProof(phase, point) {
  const source = manifest[phase]
  assert.equal(git(['rev-parse', 'HEAD']), source.sha)
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), source.tree)
  assert.equal(git(['diff', '--name-only']), '')
  assert.equal(git(['diff', '--cached', '--name-only']), '')
  const files = {}
  for (const [path, blob] of Object.entries(source.files)) {
    if (blob === null) { assert.equal(existsSync(path), false, 'Unexpected new source: ' + path); files[path] = null; continue }
    const bytes = readFileSync(path)
    assert.equal(gitBlob(bytes), blob, 'Fixed source changed: ' + path)
    files[path] = { blob, bytes: bytes.length, sha256: sha256(bytes) }
  }
  const test = readFileSync(manifest.testPath)
  assert.equal(gitBlob(test.subarray(0, manifest.originalTestBytes)), manifest.originalTestBlob, 'The complete prepared PG test file must remain the exact prefix')
  for (const [path, blob] of Object.entries(manifest.commonBlobs)) assert.equal(gitBlob(readFileSync(path)), blob, 'Common source changed: ' + path)
  const alternateIndex = join(state, phase + '-' + point + '.index')
  rmSync(alternateIndex, { force: true })
  const indexEnv = { GIT_INDEX_FILE: alternateIndex }
  try {
    git(['read-tree', 'HEAD'], indexEnv)
    git(['add', '--update', '--', '.'], indexEnv)
    assert.equal(git(['write-tree'], indexEnv), source.tree, 'Actual tracked worktree contents must match the fixed source tree')
  } finally { rmSync(alternateIndex, { force: true }) }
  return { phase, point, head: source.sha, actualWorktreeTree: source.tree, files }
}
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }) }

if (operation === 'cleanup') {
  const receipt = { runId, attempt, containerName, networkName, startedAt: new Date().toISOString(), stopped: false, containerRemoved: false, networkRemoved: false, errors: [] }
  try {
    const value = inspectIfPresent('container', containerName)
    if (value) {
      owned(value.Config.Labels)
      receipt.containerId = value.Id
      if (value.State.Running) docker(['stop', '--time', '5', value.Id])
      const stopped = JSON.parse(docker(['inspect', value.Id]))[0]
      assert.equal(stopped.State.Running, false)
      receipt.stopped = true
      receipt.removedVolumeNames = (value.Mounts ?? []).filter(row => row.Type === 'volume').map(row => row.Name)
      docker(['rm', '--volumes', value.Id])
      for (const name of receipt.removedVolumeNames) assert.equal(inspectIfPresent('volume', name), null)
      assert.equal(inspectIfPresent('container', containerName), null)
    } else receipt.stopped = true
    receipt.containerRemoved = true
  } catch (error) { receipt.errors.push({ stage: 'container', name: error.name, message: 'Owned container cleanup failed; inspect the retained resource identity' }) }
  try {
    const value = inspectIfPresent('network', networkName)
    if (value) {
      owned(value.Labels)
      receipt.networkId = value.Id
      assert.equal(Object.keys(value.Containers ?? {}).length, 0)
      docker(['network', 'rm', value.Id])
      assert.equal(inspectIfPresent('network', networkName), null)
    }
    receipt.networkRemoved = true
  } catch (error) { receipt.errors.push({ stage: 'network', name: error.name, message: 'Owned network cleanup failed; inspect the retained resource identity' }) }
  for (const path of ['postgres.env', 'database-secrets.json', 'red-environment.json', 'green-environment.json']) rmSync(join(state, path), { force: true })
  receipt.finishedAt = new Date().toISOString()
  writeJson(join(originals, 'cleanup.json'), receipt)
  console.log('ISSUE1512_NATIVE_PENDING_CLEANUP ' + JSON.stringify(receipt))
  if (receipt.errors.length) process.exitCode = 1
} else {
  admission()
  if (operation === 'prepare') {
    assert.equal(git(['rev-parse', 'HEAD']), process.env.GITHUB_SHA)
    const parents = git(['cat-file', '-p', 'HEAD']).split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7))
    assert.deepEqual(parents, [manifest.previousOps.sha, manifest.green.sha], 'This one-shot ops commit preserves the closed ops history and the exact GREEN ancestry')
    for (const source of [manifest.merge, manifest.red, manifest.green]) {
      assert.equal(git(['cat-file', '-t', source.sha]), 'commit')
      const sourceParents = git(['cat-file', '-p', source.sha]).split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7))
      assert.deepEqual(sourceParents, source.parents)
    }
    assert.deepEqual(git(['diff', '--name-only', manifest.merge.sha, manifest.red.sha]).split('\n'), [manifest.testPath])
    assert.deepEqual(git(['diff', '--name-only', manifest.red.sha, manifest.green.sha]).split('\n'), manifest.productPaths.slice().sort())
    const packageScripts = JSON.parse(readFileSync('package.json')).scripts
    assert.ok(packageScripts['test:desktop-auth'].split(' && ')[0].startsWith('node --import tsx --test '))
    assert.ok(packageScripts['test:desktop-auth'].split(' && ')[0].split(' ').includes(manifest.nativeUnitPath))
    assert.ok(packageScripts['test:activity-actor-db'].startsWith('MIKKA_READ_METRICS_TRACE=1 node --import tsx --import ./tests/fixtures/activity-runtime.mjs --test '))
    assert.ok(packageScripts['test:activity-actor-db'].split(' ').includes(manifest.testPath))
    assert.equal(packageScripts['test:e2e:setup'], 'node --experimental-strip-types scripts/setup-e2e-db.mjs')
    const control = {
      opsSha: process.env.GITHUB_SHA, opsTree: git(['rev-parse', 'HEAD^{tree}']),
      workflowBlob: git(['rev-parse', 'HEAD:.github/workflows/issue1512-native-pending-pg.yml']),
      manifestSha256: sha256(manifestBytes), driverSha256: manifest.driverSha256,
      node: process.version, pnpm: '10.34.3', capturedAt: new Date().toISOString(),
      cachePolicy: { actionsCache: false, persistentPnpmCache: false, nodeCompileCache: false, tsxDiskCache: false, dependencyInstalls: 1, independentTestProcesses: true },
    }
    git(['checkout', '--detach', '--force', manifest.red.sha])
    control.initialSourceProof = sourceProof('red', 'before-install')
    writeJson(join(state, 'control.json'), control)
    writeJson(join(originals, 'control.json'), control)
    console.log('ISSUE1512_NATIVE_PENDING_CONTROL ' + JSON.stringify(control))
  } else if (operation === 'start') {
    git(['checkout', '--detach', '--force', manifest.red.sha])
    sourceProof('red', 'after-install')
    assert.equal(inspectIfPresent('container', containerName), null)
    assert.equal(inspectIfPresent('network', networkName), null)
    const password = randomBytes(32).toString('hex')
    const url = 'postgresql://e2e:' + password + '@127.0.0.1:5432/mikka_e2e'
    mask(password); mask(url)
    writeJson(join(state, 'database-secrets.json'), { password, url })
    writeFileSync(join(state, 'postgres.env'), 'POSTGRES_USER=e2e\nPOSTGRES_DB=mikka_e2e\nPOSTGRES_PASSWORD=' + password + '\n', { mode: 0o600 })
    docker(['pull', 'postgres:17'], 240000)
    const networkId = docker(['network', 'create', ...labelArgs, networkName])
    writeJson(join(state, 'network.json'), { name: networkName, id: networkId })
    const id = docker(['run', '--detach', '--name', containerName, ...labelArgs, '--network', networkName,
      '--env-file', join(state, 'postgres.env'), '--publish', '127.0.0.1:5432:5432',
      '--health-cmd', 'pg_isready -U e2e -d mikka_e2e', '--health-interval', '2s', '--health-timeout', '5s', '--health-retries', '30', 'postgres:17'])
    assert.match(id, /^[0-9a-f]{64}$/)
    writeJson(join(state, 'container.json'), { name: containerName, id })
    const deadline = Date.now() + 100000
    let ready
    while (Date.now() < deadline) {
      ready = container()
      if (ready.health === 'healthy') break
      assert.equal(ready.running, true)
      if (ready.health === 'unhealthy') throw Error('Owned PostgreSQL health check failed')
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    assert.equal(ready.health, 'healthy', 'Owned PostgreSQL startup timed out')
    appendFileSync(process.env.GITHUB_ENV, ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL'].map(name => name + '=' + url).join('\n') + '\n')
    writeJson(join(originals, 'database-start.json'), { ...ready, networkId, startedAt: new Date().toISOString(), endpoint: { host: '127.0.0.1', port: 5432, user: 'e2e', database: 'mikka_e2e' }, credentialsMasked: true })
    console.log('ISSUE1512_NATIVE_PENDING_DATABASE_STARTED ' + JSON.stringify({ containerId: id, networkId, imageId: ready.imageId, healthy: true, loopbackOnly: true }))
  } else {
    const control = JSON.parse(readFileSync(join(state, 'control.json')))
    assert.equal(control.opsSha, process.env.GITHUB_SHA)
    assert.equal(control.manifestSha256, sha256(manifestBytes))
    assert.equal(control.driverSha256, manifest.driverSha256)
    const secret = JSON.parse(readFileSync(join(state, 'database-secrets.json')))
    mask(secret.password); mask(secret.url)
    const target = new URL(secret.url)
    assert.equal(target.hostname, '127.0.0.1')
    assert.equal(target.port, '5432')
    assert.equal(target.pathname, '/mikka_e2e')
    assert.equal(target.username, 'e2e')
    for (const name of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.equal(process.env[name], secret.url)
    assert.ok(!process.env.ORVILO_DATABASE_URL)
    const resource = container()
    assert.equal(resource.running, true); assert.equal(resource.health, 'healthy')
    const { Client } = createRequire(join(root, 'package.json'))('pg')
    const { parseSummary, checkSummary, validateTarget } = await import(pathToFileURL(join(root, 'scripts/run-db-tests.mjs')))
    const connection = async (url, work) => {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
      await client.connect()
      try { return await work(client) } finally { await client.end() }
    }
    const identity = async url => connection(url, async client => {
      const row = (await client.query('SELECT current_database() AS database, session_user AS role, current_setting(\'server_version_num\') AS version, inet_server_port() AS port, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid')).rows[0]
      assert.equal(row.database, 'mikka_e2e'); assert.equal(row.role, 'e2e'); assert.equal(row.port, 5432); assert.match(row.version, /^17/)
      assert.equal((await client.query("SELECT to_regclass('public.schema_migrations') AS relation")).rows[0].relation, null, 'Each phase must begin with a fresh database')
      return row
    })
    const controlName = 'mikka_native_pending_control_e2e'
    const controlUrl = new URL(secret.url); controlUrl.pathname = '/' + controlName
    mask(controlUrl.toString())
    const sensitive = [secret.password, secret.url, controlUrl.toString()]
    const receipt = { schema: 'issue1512-native-pending-pg17-v1', runId, attempt, control, red: manifest.red, green: manifest.green, startedAt: new Date().toISOString(), resource, units: [], phases: [], commands: [], verdict: 'IN_PROGRESS' }
    const persist = () => writeJson(join(originals, 'receipt.json'), receipt)
    persist()
    const command = async (phase, label, executable, args, env, timeoutMs = 180000) => {
      const startedAt = new Date().toISOString()
      console.log('ISSUE1512_NATIVE_PENDING_COMMAND_START ' + JSON.stringify({ phase, label, executable, args, timeoutMs, startedAt }))
      const result = await new Promise(resolve => {
        const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
        const stdout = [], stderr = []
        let timedOut = false, spawnError = null
        const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, timeoutMs)
        child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk))
        child.on('error', error => { spawnError = error.code ?? 'SPAWN_ERROR' })
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, spawnError, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }) })
      })
      const entry = { phase, label, executable, args, startedAt, finishedAt: new Date().toISOString(), code: result.code, signal: result.signal, timedOut: result.timedOut, spawnError: result.spawnError }
      for (const stream of ['stdout', 'stderr']) {
        assert.ok(!sensitive.some(value => result[stream].includes(value)), 'Temporary credential appeared in child output; original export blocked')
        const file = phase + '-' + label + '-' + stream + '.log'
        writeFileSync(join(originals, file), result[stream], { mode: 0o600 })
        entry[stream] = { file, bytes: result[stream].length, sha256: sha256(result[stream]) }
        console.log('ISSUE1512_NATIVE_PENDING_ORIGINAL_BEGIN ' + JSON.stringify({ phase, label, stream, ...entry[stream] }))
        const encoded = result[stream].toString('base64')
        for (let offset = 0; offset < encoded.length; offset += 12000) console.log('ISSUE1512_NATIVE_PENDING_ORIGINAL_CHUNK ' + encoded.slice(offset, offset + 12000))
        console.log('ISSUE1512_NATIVE_PENDING_ORIGINAL_END ' + JSON.stringify({ phase, label, stream }))
      }
      receipt.commands.push(entry); persist()
      console.log('ISSUE1512_NATIVE_PENDING_COMMAND_END ' + JSON.stringify(entry))
      assert.equal(result.timedOut, false, 'Command timeout is not a valid regression RED')
      assert.equal(result.spawnError, null, 'Command spawn failure is not a valid regression RED')
      assert.equal(result.signal, null, 'Command signal is not a valid regression RED')
      return { ...result, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
    }
    function passing(label, result, summary = false) {
      assert.equal(result.code, 0, label + ' failed')
      if (summary) assert.equal(checkSummary(label, result.code, parseSummary(result.stdout + '\n' + result.stderr)), null)
    }
    function tapFailures(output) {
      return [...output.matchAll(/^([ ]*)not ok \d+ - (.+)$/gm)].map(match => {
        const rest = output.slice(match.index + match[0].length)
        const end = new RegExp('^' + match[1] + '  \\.\\.\\.\\s*$', 'm').exec(rest)
        assert.ok(end, 'Incomplete TAP failure diagnostics')
        return { name: match[2], diagnostic: rest.slice(0, end.index + end[0].length) }
      })
    }
    const errorProjection = error => ({
      name: error.name, code: error.code,
      message: sensitive.some(value => String(error.message).includes(value)) ? 'Temporary credential omitted from diagnostic' : error.message,
    })
    try {
      // A failed merge diagnosis must not suppress either the Native unit file
      // or the real database experiment. Each command keeps its own real status.
      for (const unit of manifest.units) {
        const row = { label: unit.label, phase: unit.phase, expectedTests: unit.expectedTests, startedAt: new Date().toISOString(), verdict: 'IN_PROGRESS' }
        receipt.units.push(row); persist()
        try {
          git(['checkout', '--detach', '--force', manifest[unit.phase].sha])
          row.sourceProof = sourceProof(unit.phase, 'before-' + unit.label)
          const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1' }
          for (const key of ['REQUIRE_DB', 'E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL', 'NODE_COMPILE_CACHE', 'DB_TEST_SHARD', 'DB_TEST_SELECTED', 'DB_TEST_EXPECTED']) delete env[key]
          const result = await command(unit.phase, unit.label, process.execPath, unit.args, env, 120000)
          row.code = result.code
          row.summary = parseSummary(result.stdout + '\n' + result.stderr)
          row.failures = tapFailures(result.stdout)
          passing(unit.label, result, true)
          assert.equal(row.summary.tests, unit.expectedTests, 'The entire fixed unit file must run')
          assert.equal(row.failures.length, 0)
          row.verdict = 'COMPLETE_UNIT_FILE_PASS'
        } catch (error) {
          row.verdict = 'UNIT_FILE_FAILED_OR_BLOCKED'
          row.failure = errorProjection(error)
        } finally {
          try { row.afterTestProof = sourceProof(unit.phase, 'after-' + unit.label) }
          catch (error) { row.verdict = 'UNIT_SOURCE_PROOF_FAILED'; row.sourceFailure = errorProjection(error) }
          row.finishedAt = new Date().toISOString(); persist()
          console.log('ISSUE1512_NATIVE_PENDING_UNIT ' + JSON.stringify(row))
        }
      }
      receipt.unitVerdict = receipt.units.length === 2 && receipt.units.every(row => row.verdict === 'COMPLETE_UNIT_FILE_PASS') ? 'BOTH_UNIT_FILES_PASS' : 'UNIT_DIAGNOSTIC_FAILURE'
      git(['checkout', '--detach', '--force', manifest.red.sha])
      receipt.initialDatabase = await identity(secret.url)
      receipt.catalogBefore = await connection(secret.url, async client => {
        const rows = (await client.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows
        assert.ok(!rows.some(row => row.datname === controlName))
        await client.query('CREATE DATABASE "' + controlName + '" TEMPLATE template0')
        return rows
      })
      for (const phase of ['red', 'green']) {
        const phaseReceipt = { phase, startedAt: new Date().toISOString(), verdict: 'IN_PROGRESS' }
        receipt.phases.push(phaseReceipt); persist()
        try {
          if (phase === 'green') {
            const reset = { startedAt: new Date().toISOString(), oldDatabaseOid: receipt.initialDatabase.oid, removed: [] }
            await connection(controlUrl.toString(), async client => {
              const rows = (await client.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows
              for (const row of rows) {
                if (receipt.catalogBefore.some(old => old.datname === row.datname) || row.datname === controlName) continue
                assert.match(row.datname, /^bootstrap_[0-9a-f]{32}$/, 'Only bootstrap databases created by this job may be removed')
                await client.query('DROP DATABASE "' + row.datname + '" WITH (FORCE)')
                reset.removed.push(row)
              }
              await client.query('DROP DATABASE mikka_e2e WITH (FORCE)')
              await client.query('CREATE DATABASE mikka_e2e TEMPLATE template0')
            })
            reset.newDatabase = await identity(secret.url)
            assert.notEqual(reset.newDatabase.oid, reset.oldDatabaseOid, 'GREEN must use a newly created database')
            reset.finishedAt = new Date().toISOString()
            receipt.databaseReset = reset; persist()
            console.log('ISSUE1512_NATIVE_PENDING_DATABASE_RESET ' + JSON.stringify(reset))
          }
          const source = manifest[phase]
          git(['checkout', '--detach', '--force', source.sha])
          phaseReceipt.sourceProof = sourceProof(phase, 'before-test')
          phaseReceipt.database = phase === 'red' ? receipt.initialDatabase : receipt.databaseReset.newDatabase
          const authSecret = randomBytes(32).toString('hex'); mask(authSecret); sensitive.push(authSecret)
          const environmentFile = join(state, phase + '-environment.json')
          assert.equal(existsSync(environmentFile), false)
          const env = { ...process.env, CI: 'true', REQUIRE_DB: '1', MIKKA_TEST_DEPLOYMENT_SHA: source.sha, MIKKA_TEST_ENVIRONMENT_FILE: environmentFile, BETTER_AUTH_SECRET: authSecret, BETTER_AUTH_URL: 'http://localhost:3100', MIKKA_TEST_DB_PORT: '5432', MIKKA_READ_METRICS_TRACE: '1', NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1' }
          for (const key of ['DB_TEST_SHARD', 'DB_TEST_SELECTED', 'DB_TEST_EXPECTED', 'NODE_COMPILE_CACHE']) delete env[key]
          validateTarget(env)
          passing('migration-bootstrap', await command(phase, 'migration-bootstrap', process.execPath, ['--test-reporter=tap', '--experimental-strip-types', '--test', 'tests/migrate-empty-db.test.mjs'], { ...env, MIGRATION_BOOTSTRAP_CI: '1' }), true)
          passing('e2e-setup', await command(phase, 'e2e-setup', 'pnpm', ['test:e2e:setup'], env))
          passing('environment-bind', await command(phase, 'environment-bind', process.execPath, ['scripts/test-accounts/bootstrap.mjs', '--output', environmentFile], env))
          const result = await command(phase, 'action-read-egress', process.execPath, ['--test-reporter=tap', '--import', 'tsx', '--import', './tests/fixtures/activity-runtime.mjs', '--test', manifest.testPath], env, 240000)
          const summary = parseSummary(result.stdout + '\n' + result.stderr)
          phaseReceipt.code = result.code
          phaseReceipt.summary = summary
          assert.equal(summary.tests, manifest.expectedTests, 'The exact full test file must run')
          for (const key of ['skipped', 'todo', 'cancelled']) assert.equal(summary[key] ?? 0, 0, key + ' is forbidden')
          const failures = tapFailures(result.stdout)
          phaseReceipt.failures = failures
          if (phase === 'red') {
            assert.equal(result.code, 1, 'Old product must fail only the two specified query assertions')
            const leaves = failures.filter(row => !/failureType:\s*['"]?subtestsFailed/.test(row.diagnostic))
            const parents = failures.filter(row => /failureType:\s*['"]?subtestsFailed/.test(row.diagnostic))
            assert.deepEqual(leaves.map(row => row.name), manifest.expectedRedLeaves.map(row => row.name))
            assert.deepEqual(parents.map(row => row.name), [manifest.expectedRedParent])
            for (const [index, failure] of leaves.entries()) {
              const expected = manifest.expectedRedLeaves[index]
              assert.match(failure.diagnostic, /failureType:\s*['"]?testCodeFailure/)
              assert.match(failure.diagnostic, /code:\s*['"]?ERR_ASSERTION/)
              assert.ok(failure.diagnostic.replace(/\s+/g, ' ').includes(expected.message))
              assert.match(failure.diagnostic, new RegExp('^\\s+expected: ' + expected.expected + '\\s*$', 'm'))
              assert.match(failure.diagnostic, new RegExp('^\\s+actual: ' + expected.actual + '\\s*$', 'm'))
            }
            assert.equal(summary.fail, 3)
            assert.equal(summary.pass, summary.tests - 3)
            phaseReceipt.verdict = 'EXACT_TWO_QUERY_ASSERTIONS_RED'
          } else {
            passing('complete action read egress file', result, true)
            assert.equal(failures.length, 0)
            for (const row of manifest.expectedRedLeaves) assert.ok(result.stdout.includes(' - ' + row.name + '\n'))
            phaseReceipt.verdict = 'COMPLETE_ACTION_READ_EGRESS_GREEN'
          }
        } catch (error) {
          phaseReceipt.verdict = 'BLOCKED_OR_UNEXPECTED_FAILURE'
          phaseReceipt.failure = errorProjection(error)
        } finally {
          try { phaseReceipt.afterTestProof = sourceProof(phase, 'after-test') }
          catch (error) { phaseReceipt.verdict = 'SOURCE_PROOF_FAILED'; phaseReceipt.sourceFailure = errorProjection(error) }
          phaseReceipt.finishedAt = new Date().toISOString()
          persist()
          console.log('ISSUE1512_NATIVE_PENDING_PHASE ' + JSON.stringify(phaseReceipt))
        }
      }
      receipt.pgVerdict = receipt.phases[0]?.verdict === 'EXACT_TWO_QUERY_ASSERTIONS_RED'
        && receipt.phases[1]?.verdict === 'COMPLETE_ACTION_READ_EGRESS_GREEN'
        ? 'EXACT_RED_AND_COMPLETE_GREEN' : 'PG_PROOF_FAILED'
      receipt.verdict = receipt.pgVerdict === 'EXACT_RED_AND_COMPLETE_GREEN'
        ? receipt.unitVerdict === 'BOTH_UNIT_FILES_PASS' ? 'ALL_FIXED_SOURCE_CHECKS_PASSED' : 'PG_PROVEN_WITH_UNIT_DIAGNOSTIC_FAILURE'
        : 'BLOCKED_OR_UNEXPECTED_FAILURE'
      if (receipt.verdict !== 'ALL_FIXED_SOURCE_CHECKS_PASSED') process.exitCode = 1
    } catch (error) {
      receipt.verdict = 'BLOCKED_OR_UNEXPECTED_FAILURE'
      receipt.failure = { name: error.name, code: error.code, message: sensitive.some(value => String(error.message).includes(value)) ? 'Temporary credential omitted from diagnostic' : error.message }
      process.exitCode = 1
    } finally {
      receipt.finishedAt = new Date().toISOString()
      persist()
      console.log('ISSUE1512_NATIVE_PENDING_VERDICT ' + JSON.stringify(receipt))
    }
  }
}
