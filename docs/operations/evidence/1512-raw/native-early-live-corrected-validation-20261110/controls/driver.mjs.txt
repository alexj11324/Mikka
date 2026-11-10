import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants, createRequire, enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const operation = process.argv[2]
assert.ok(['prepare', 'start', 'run', 'cleanup'].includes(operation))
const root = process.cwd()
const state = join(process.env.RUNNER_TEMP, 'issue1512-native-live-routing-validation')
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
const containerName = 'issue1512-native-live-routing-validation-' + runId + '-' + attempt
const networkName = 'issue1512-native-live-routing-net-' + runId + '-' + attempt
const ownership = { 'mikka.issue': '1512', 'mikka.runner': 'live-routing-validation', 'mikka.github-run': runId, 'mikka.github-attempt': attempt, 'mikka.github-sha': process.env.GITHUB_SHA }
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

const unitGroups = [
  {
    "label": "live-routing-regressions",
    "args": [
      "--test-reporter=tap",
      "--import",
      "tsx",
      "--test",
      "lib/live/channels.test.ts"
    ]
  },
  {
    "label": "workspace-app",
    "args": [
      "--test-reporter=tap",
      "--test",
      "apps/desktop/scripts/workspace-live.test.mjs"
    ]
  },
  {
    "label": "cloud-startup",
    "args": [
      "--test-reporter=tap",
      "--import",
      "tsx",
      "--test",
      "scripts/acceptance/cloud-startup.test.mjs"
    ]
  }
]
const typeChecks = [
  { label: 'root-types', args: ['exec', 'tsrs', '--noEmit'] },
  { label: 'frontend-types', args: ['--filter', '@mikka/frontend', 'typecheck'] },
  { label: 'desktop-renderer-types', args: ['--filter', '@mikka/desktop', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.renderer.json'] },
]
const testPath = 'tests/read-cache-scope.db.test.ts'
const additionalLintPaths = []
const controlPaths = [
  '.github/ops/issue1512-native-live-routing-validation/driver.mjs',
  '.github/ops/issue1512-native-live-routing-validation/manifest.json',
  '.github/workflows/issue1512-native-live-routing-validation.yml',
]
function admission() {
  assert.equal(manifest.schema, 'issue1512-native-live-routing-validation/v1')
  assert.equal(manifest.enabled, true, 'Closed validation admission')
  assert.equal(manifest.draft, false, 'Unbound template cannot execute')
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
  assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=4096')
  assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1')
  assert.equal(process.env.TSX_DISABLE_CACHE, '1')
  assert.equal(process.env.MIKKA_READ_METRICS_TRACE, '1')
  assert.equal(enableCompileCache().status, constants.compileCacheStatus.DISABLED)
  assert.equal(sha256(readFileSync(fileURLToPath(import.meta.url))), manifest.driverSha256)
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH))
  assert.equal(event.after, process.env.GITHUB_SHA)
  assert.equal(event.head_commit?.message, manifest.admissionMessage)
  for (const name of ['INFISICAL_TOKEN', 'INFISICAL_CLIENT_SECRET', 'POSTHOG_API_KEY', 'POSTHOG_PERSONAL_API_KEY',
    'NEXT_PUBLIC_POSTHOG_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VERCEL_TOKEN', 'NEON_API_KEY', 'RESEND_API_KEY',
    'E2B_API_KEY', 'LINEAR_API_KEY', 'GITHUB_APP_PRIVATE_KEY', 'SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'BETTER_AUTH_SECRET']) {
    assert.ok(!process.env[name], 'Unexpected external credential: ' + name)
  }
  for (const source of [manifest.merge, manifest.previousSource, manifest.source]) {
    for (const key of ['sha', 'tree']) assert.match(source[key], /^[0-9a-f]{40}$/)
    assert.ok(Array.isArray(source.parents))
    for (const parent of source.parents) assert.match(parent, /^[0-9a-f]{40}$/)
  }
  assert.match(manifest.previousOps.sha, /^[0-9a-f]{40}$/)
  assert.deepEqual(manifest.previousSource.parents, [manifest.merge.sha])
  assert.deepEqual(manifest.source.parents, [manifest.previousSource.sha])
  assert.equal(manifest.previousSource.sha, 'ff385bfd91edcd40c3b3ee398b4b93098e5becbb')
  assert.equal(manifest.previousRun.id, 42766089161)
  assert.equal(manifest.previousRun.conclusion, 'failure')
  assert.equal(manifest.testPath, testPath)
  assert.equal(manifest.expectedPgTests, 15)
  assert.deepEqual(manifest.unitGroups, unitGroups)
  assert.deepEqual(Object.keys(manifest.expectedUnitTests).sort(), unitGroups.map(unit => unit.label).sort())
  for (const unit of unitGroups) assert.ok(Number.isSafeInteger(manifest.expectedUnitTests[unit.label]) && manifest.expectedUnitTests[unit.label] > 0,
    'Every complete unit group requires a source-derived exact positive count')
  assert.deepEqual(manifest.typeChecks, typeChecks)
  assert.deepEqual(manifest.controlPaths, controlPaths)
  assert.deepEqual(manifest.additionalLintPaths, additionalLintPaths)
  assert.deepEqual(manifest.lintPaths, [...new Set([...manifest.changedSinceFailedPaths.filter(path => /\.(?:tsx?|mjs)$/.test(path)), ...additionalLintPaths])].sort())
  assert.ok(manifest.lintPaths.length > 0)
  assert.deepEqual(manifest.packageScriptBindings.map(binding => binding.packagePath === 'package.json' ? binding.testToken : binding.packagePath.slice(0, binding.packagePath.lastIndexOf('/') + 1) + binding.testToken).sort(),
    ['apps/desktop/src/renderer/workspace-live.test.ts', 'lib/live/channels.test.ts'])
  for (const path of [...manifest.productPaths, ...manifest.changedSinceFailedPaths, ...manifest.lintPaths]) {
    assert.ok(!path.startsWith('-') && !path.startsWith('/') && !path.split('/').includes('..'))
    assert.match(manifest.source.files[path], /^[0-9a-f]{40}$/)
  }
  for (const path of [...unitGroups.flatMap(group => group.args.filter(arg => /\.test\.(?:ts|mjs)$/.test(arg))), testPath]) {
    assert.match(manifest.source.files[path], /^[0-9a-f]{40}$/, 'Every executed test file must be source-bound')
  }
}
function sourceProof(point) {
  const source = manifest.source
  assert.equal(git(['rev-parse', 'HEAD']), source.sha)
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), source.tree)
  assert.equal(git(['diff', '--name-only', '--no-renames']), '')
  assert.equal(git(['diff', '--cached', '--name-only', '--no-renames']), '')
  const files = {}
  for (const [path, blob] of Object.entries(source.files)) {
    const bytes = readFileSync(path)
    assert.equal(gitBlob(bytes), blob, 'Fixed source changed: ' + path)
    files[path] = { blob, bytes: bytes.length, sha256: sha256(bytes) }
  }
  const original = readFileSync(testPath).subarray(0, manifest.originalTestBytes)
  assert.equal(gitBlob(original), manifest.originalTestBlob, 'The complete original cache authorization test must remain the exact prefix')
  for (const [path, blob] of Object.entries(manifest.commonBlobs)) assert.equal(gitBlob(readFileSync(path)), blob, 'Common source changed: ' + path)
  const alternateIndex = join(state, point + '.index')
  rmSync(alternateIndex, { force: true })
  const indexEnv = { GIT_INDEX_FILE: alternateIndex }
  try {
    git(['read-tree', 'HEAD'], indexEnv)
    git(['add', '--update', '--', '.'], indexEnv)
    assert.equal(git(['write-tree'], indexEnv), source.tree, 'Actual tracked worktree contents must match the fixed source tree')
  } finally { rmSync(alternateIndex, { force: true }) }
  return { point, head: source.sha, actualWorktreeTree: source.tree, files }
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
  for (const path of ['postgres.env', 'database-secrets.json', 'green-environment.json']) rmSync(join(state, path), { force: true })
  receipt.finishedAt = new Date().toISOString()
  writeJson(join(originals, 'cleanup.json'), receipt)
  console.log('ISSUE1512_LIVE_ROUTING_CLEANUP ' + JSON.stringify(receipt))
  if (receipt.errors.length) process.exitCode = 1
} else {
  admission()
  if (operation === 'prepare') {
    assert.equal(git(['rev-parse', 'HEAD']), process.env.GITHUB_SHA)
    const parents = git(['cat-file', '-p', 'HEAD']).split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7))
    assert.deepEqual(parents, [manifest.previousOps.sha, manifest.source.sha], 'The ops entry preserves the closed evidence archive and exact candidate ancestry')
    assert.deepEqual(git(['diff', '--name-only', '--no-renames', manifest.source.sha, 'HEAD']).split('\n'), controlPaths)
    assert.equal(git(['rev-parse', 'HEAD:' + controlPaths[2]]), manifest.workflowBlob)
    for (const source of [manifest.merge, manifest.previousSource, manifest.source]) {
      assert.equal(git(['cat-file', '-t', source.sha]), 'commit')
      assert.equal(git(['rev-parse', source.sha + '^{tree}']), source.tree)
      const sourceParents = git(['cat-file', '-p', source.sha]).split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7))
      assert.deepEqual(sourceParents, source.parents)
    }
    assert.deepEqual(git(['diff', '--name-only', '--no-renames', manifest.merge.sha, manifest.source.sha]).split('\n'), manifest.productPaths)
    assert.deepEqual(git(['diff', '--name-only', '--no-renames', manifest.previousSource.sha, manifest.source.sha]).split('\n'), manifest.changedSinceFailedPaths)
    assert.deepEqual(manifest.changedSinceFailedPaths, [
      'apps/desktop/scripts/workspace-live.test.mjs', 'hooks/use-subagent-updates.ts',
      'lib/live/channels.test.ts', 'tests/read-cache-scope.db.test.ts',
    ])
    const packageScripts = JSON.parse(readFileSync('package.json')).scripts
    assert.ok(packageScripts['test:desktop-auth'].split(' && ')[0].startsWith('node --import tsx --test '))
    assert.ok(packageScripts['test:desktop-auth'].split(' && ')[0].split(' ').includes('lib/desktop-rpc/wire.test.ts'))
    assert.ok(packageScripts['test:device-gateway'].split(' && ').some(step => step.startsWith('node --import tsx --test ') && step.split(' ').includes('lib/live/channel.test.ts')))
    assert.ok(packageScripts['test:activity-actor-db'].startsWith('MIKKA_READ_METRICS_TRACE=1 node --import tsx --import ./tests/fixtures/activity-runtime.mjs --test '))
    assert.ok(packageScripts['test:activity-actor-db'].split(' ').includes(testPath))
    assert.equal(packageScripts['test:e2e:setup'], 'node --experimental-strip-types scripts/setup-e2e-db.mjs')
    assert.equal(JSON.parse(readFileSync('apps/frontend/package.json')).scripts.typecheck, 'tsc --noEmit -p tsconfig.json')
    for (const binding of manifest.packageScriptBindings) {
      const script = JSON.parse(readFileSync(binding.packagePath)).scripts[binding.script]
      assert.ok(script?.split(' && ').some(step => step.startsWith(binding.prefix) && step.split(' ').includes(binding.testToken)),
        'New tests must remain registered in the ordinary CI package script')
    }
    const control = {
      opsSha: process.env.GITHUB_SHA, opsTree: git(['rev-parse', 'HEAD^{tree}']), workflowBlob: manifest.workflowBlob,
      manifestSha256: sha256(manifestBytes), driverSha256: manifest.driverSha256,
      merge: manifest.merge, previousSource: manifest.previousSource, previousRun: manifest.previousRun,
      reusedResults: manifest.reusedResults,
      candidate: { sha: manifest.source.sha, tree: manifest.source.tree, parents: manifest.source.parents },
      node: process.version, pnpm: '10.34.3', nodeOptions: process.env.NODE_OPTIONS, capturedAt: new Date().toISOString(),
      cachePolicy: { actionsCache: false, persistentPnpmCache: false, nodeCompileCache: false, tsxDiskCache: false,
        dependencyInstalls: 1, independentTestProcesses: true },
      validationKind: 'one corrected forward candidate; rerun failed or changed scopes, retain source-bound unaffected results from the failed predecessor',
    }
    git(['checkout', '--detach', '--force', manifest.source.sha])
    control.initialSourceProof = sourceProof('before-install')
    writeJson(join(state, 'control.json'), control)
    writeJson(join(originals, 'control.json'), control)
    console.log('ISSUE1512_LIVE_ROUTING_CONTROL ' + JSON.stringify(control))
  } else if (operation === 'start') {
    sourceProof('after-install')
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
    writeJson(join(originals, 'database-start.json'), { ...ready, networkId, startedAt: new Date().toISOString(),
      endpoint: { host: '127.0.0.1', port: 5432, user: 'e2e', database: 'mikka_e2e' }, credentialsMasked: true })
    console.log('ISSUE1512_LIVE_ROUTING_DATABASE_STARTED ' + JSON.stringify({ containerId: id, networkId, imageId: ready.imageId, healthy: true, loopbackOnly: true }))
  } else {
    const control = JSON.parse(readFileSync(join(state, 'control.json')))
    assert.equal(control.opsSha, process.env.GITHUB_SHA)
    assert.equal(control.manifestSha256, sha256(manifestBytes))
    assert.equal(control.driverSha256, manifest.driverSha256)
    const secret = JSON.parse(readFileSync(join(state, 'database-secrets.json')))
    mask(secret.password); mask(secret.url)
    const target = new URL(secret.url)
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, '5432')
    assert.equal(target.pathname, '/mikka_e2e'); assert.equal(target.username, 'e2e')
    for (const name of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.equal(process.env[name], secret.url)
    assert.ok(!process.env.ORVILO_DATABASE_URL)
    const resource = container()
    assert.equal(resource.running, true); assert.equal(resource.health, 'healthy')
    const { Client } = createRequire(join(root, 'package.json'))('pg')
    const { parseSummary, checkSummary, validateTarget } = await import(pathToFileURL(join(root, 'scripts/run-db-tests.mjs')))
    const connection = async work => {
      const client = new Client({ connectionString: secret.url, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
      await client.connect()
      try { return await work(client) } finally { await client.end() }
    }
    const identity = async () => connection(async client => {
      const row = (await client.query('SELECT current_database() AS database, session_user AS role, current_setting(\'server_version_num\') AS version, inet_server_port() AS port, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid')).rows[0]
      assert.equal(row.database, 'mikka_e2e'); assert.equal(row.role, 'e2e'); assert.equal(row.port, 5432); assert.match(row.version, /^17/)
      assert.equal((await client.query("SELECT to_regclass('public.schema_migrations') AS relation")).rows[0].relation, null, 'GREEN must begin with a fresh database')
      return row
    })
    const sensitive = [secret.password, secret.url]
    const receipt = {
      schema: 'issue1512-native-live-routing-green-v1', runId, attempt, control,
      source: manifest.source, startedAt: new Date().toISOString(), resource,
      units: [], checks: [], pg: null, commands: [], verdict: 'IN_PROGRESS',
    }
    const persist = () => writeJson(join(originals, 'receipt.json'), receipt)
    const errorProjection = error => ({
      name: error.name, code: error.code,
      message: sensitive.some(value => String(error.message).includes(value)) ? 'Temporary credential omitted from diagnostic' : error.message,
    })
    persist()
    const command = async (label, executable, args, env, timeoutMs = 180000) => {
      const entry = { label, executable, args, startedAt: new Date().toISOString(), status: 'PREPARING' }
      receipt.commands.push(entry); persist()
      console.log('ISSUE1512_LIVE_ROUTING_COMMAND_START ' + JSON.stringify({ ...entry, timeoutMs }))
      try {
        entry.beforeSourceProof = sourceProof('before-' + label)
        entry.status = 'RUNNING'; persist()
        const result = await new Promise(resolve => {
          const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
          const stdout = [], stderr = []
          let timedOut = false, spawnError = null
          const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, timeoutMs)
          child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk))
          child.on('error', error => { spawnError = error.code ?? 'SPAWN_ERROR' })
          child.on('close', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal, timedOut, spawnError, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
          })
        })
        Object.assign(entry, { code: result.code, signal: result.signal, timedOut: result.timedOut, spawnError: result.spawnError, status: 'EXITED' })
        for (const stream of ['stdout', 'stderr']) {
          assert.ok(!sensitive.some(value => result[stream].includes(value)), 'Temporary credential appeared in child output; original export blocked')
          const file = label + '-' + stream + '.log'
          writeFileSync(join(originals, file), result[stream], { mode: 0o600 })
          entry[stream] = { file, bytes: result[stream].length, sha256: sha256(result[stream]) }
          console.log('ISSUE1512_LIVE_ROUTING_ORIGINAL_BEGIN ' + JSON.stringify({ label, stream, ...entry[stream] }))
          const encoded = result[stream].toString('base64')
          for (let offset = 0; offset < encoded.length; offset += 12000) console.log('ISSUE1512_LIVE_ROUTING_ORIGINAL_CHUNK ' + encoded.slice(offset, offset + 12000))
          console.log('ISSUE1512_LIVE_ROUTING_ORIGINAL_END ' + JSON.stringify({ label, stream }))
        }
        entry.originalsPreserved = true
        persist()
        assert.equal(result.timedOut, false, 'Command timeout is a failed validation')
        assert.equal(result.spawnError, null, 'Command spawn failure is a failed validation')
        assert.equal(result.signal, null, 'Command signal is a failed validation')
        return { ...result, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
      } catch (error) {
        entry.failure = errorProjection(error)
        if (entry.status === 'PREPARING') entry.status = 'NOT_RUN'
        throw error
      } finally {
        let sourceError
        try { entry.afterSourceProof = sourceProof('after-' + label) }
        catch (error) { entry.sourceFailure = errorProjection(error); sourceError = error }
        entry.finishedAt = new Date().toISOString(); persist()
        console.log('ISSUE1512_LIVE_ROUTING_COMMAND_END ' + JSON.stringify(entry))
        if (sourceError) throw sourceError
      }
    }
    function passing(label, result, expectedTests = null) {
      assert.equal(result.code, 0, label + ' failed')
      const summary = parseSummary(result.stdout + '\n' + result.stderr)
      assert.equal(checkSummary(label, result.code, summary), null)
      if (expectedTests !== null) assert.equal(summary.tests, expectedTests, 'The entire fixed test file must run')
      return summary
    }
    const nonDbEnvironment = () => {
      const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1', NODE_OPTIONS: '--max-old-space-size=4096' }
      for (const key of ['REQUIRE_DB', 'E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL',
        'NODE_COMPILE_CACHE', 'DB_TEST_SHARD', 'DB_TEST_SELECTED', 'DB_TEST_EXPECTED', 'MIKKA_TEST_ENVIRONMENT_FILE',
        'MIKKA_TEST_DEPLOYMENT_SHA', 'MIGRATION_BOOTSTRAP_CI', 'BETTER_AUTH_SECRET']) delete env[key]
      return env
    }
    const runUnit = async unit => {
      const row = { label: unit.label, expectedTests: manifest.expectedUnitTests[unit.label], startedAt: new Date().toISOString(), verdict: 'IN_PROGRESS' }
      receipt.units.push(row); persist()
      try {
        const result = await command(unit.label, process.execPath, unit.args, nonDbEnvironment(), 120000)
        row.code = result.code
        row.summary = parseSummary(result.stdout + '\n' + result.stderr)
        row.failureNames = [...result.stdout.matchAll(/^[ ]*not ok \d+ - (.+)$/gm)].map(match => match[1])
        passing(unit.label, result, manifest.expectedUnitTests[unit.label])
        row.verdict = 'COMPLETE_UNIT_GROUP_PASS'
      } catch (error) {
        row.verdict = 'UNIT_GROUP_FAILED_OR_BLOCKED'; row.failure = errorProjection(error)
      } finally {
        row.finishedAt = new Date().toISOString(); persist()
        console.log('ISSUE1512_LIVE_ROUTING_UNIT ' + JSON.stringify(row))
      }
    }
    const runCheck = async (label, args, executable = 'pnpm') => {
      const row = { label, startedAt: new Date().toISOString(), verdict: 'IN_PROGRESS' }
      receipt.checks.push(row); persist()
      try {
        const result = await command(label, executable, args, nonDbEnvironment(), 240000)
        row.code = result.code
        assert.equal(result.code, 0, label + ' failed')
        row.verdict = 'CHECK_PASS'
      } catch (error) {
        row.verdict = 'CHECK_FAILED_OR_BLOCKED'; row.failure = errorProjection(error)
      } finally {
        row.finishedAt = new Date().toISOString(); persist()
        console.log('ISSUE1512_LIVE_ROUTING_CHECK ' + JSON.stringify(row))
      }
    }
    try {
      // Every group retains its real status. A failed unit/lint/type command
      // cannot suppress the other groups, the PG proof, or final owned cleanup.
      for (const unit of unitGroups) await runUnit(unit)
      const rootLintPaths = manifest.lintPaths.filter(path => !path.startsWith('apps/desktop/'))
      const desktopLintPaths = manifest.lintPaths.filter(path => path.startsWith('apps/desktop/')).map(path => path.slice('apps/desktop/'.length))
      assert.ok(rootLintPaths.length > 0 && desktopLintPaths.length > 0)
      assert.ok(desktopLintPaths.every(path => /^(?:src|scripts)\//.test(path)), 'Existing desktop lint must cover every changed desktop source')
      await runCheck('changed-root-oxlint', ['exec', 'oxlint', '--deny-warnings', ...rootLintPaths])
      await runCheck('desktop-source-oxlint', ['--filter', '@mikka/desktop', 'lint'])
      const pg = receipt.pg = { startedAt: new Date().toISOString(), verdict: 'IN_PROGRESS' }
      persist()
      try {
        pg.database = await identity()
        pg.catalogBefore = await connection(async client => (await client.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows)
        const authSecret = randomBytes(32).toString('hex'); mask(authSecret); sensitive.push(authSecret)
        const environmentFile = join(state, 'green-environment.json')
        assert.equal(existsSync(environmentFile), false)
        const env = {
          ...process.env, CI: 'true', REQUIRE_DB: '1', MIKKA_TEST_DEPLOYMENT_SHA: manifest.source.sha,
          MIKKA_TEST_ENVIRONMENT_FILE: environmentFile, BETTER_AUTH_SECRET: authSecret, BETTER_AUTH_URL: 'http://localhost:3100',
          MIKKA_TEST_DB_PORT: '5432', MIKKA_READ_METRICS_TRACE: '1', NODE_DISABLE_COMPILE_CACHE: '1',
          TSX_DISABLE_CACHE: '1', NODE_OPTIONS: '--max-old-space-size=4096',
        }
        for (const key of ['DB_TEST_SHARD', 'DB_TEST_SELECTED', 'DB_TEST_EXPECTED', 'NODE_COMPILE_CACHE']) delete env[key]
        validateTarget(env)
        const migration = await command('migration-bootstrap', process.execPath,
          ['--test-reporter=tap', '--experimental-strip-types', '--test', 'tests/migrate-empty-db.test.mjs'], { ...env, MIGRATION_BOOTSTRAP_CI: '1' })
        pg.migrationSummary = passing('migration-bootstrap', migration)
        const setup = await command('e2e-setup', 'pnpm', ['test:e2e:setup'], env)
        assert.equal(setup.code, 0, 'e2e-setup failed')
        const binding = await command('environment-bind', process.execPath, ['scripts/test-accounts/bootstrap.mjs', '--output', environmentFile], env)
        assert.equal(binding.code, 0, 'environment-bind failed')
        const result = await command('cache-scope-pg', process.execPath,
          ['--test-reporter=tap', '--import', 'tsx', '--import', './tests/fixtures/activity-runtime.mjs', '--test', testPath], env, 240000)
        pg.code = result.code
        pg.summary = parseSummary(result.stdout + '\n' + result.stderr)
        pg.failureNames = [...result.stdout.matchAll(/^[ ]*not ok \d+ - (.+)$/gm)].map(match => match[1])
        passing('complete cache-scope PG file', result, manifest.expectedPgTests)
        pg.verdict = 'COMPLETE_CACHE_SCOPE_PG_PASS'
      } catch (error) {
        pg.verdict = 'PG_FAILED_OR_BLOCKED'; pg.failure = errorProjection(error)
      } finally {
        try { pg.catalogAfter = await connection(async client => (await client.query('SELECT datname,oid::text AS oid FROM pg_database ORDER BY datname')).rows) }
        catch (error) { pg.catalogFailure = errorProjection(error); pg.verdict = 'PG_FINAL_IDENTITY_FAILED' }
        pg.finishedAt = new Date().toISOString(); persist()
        console.log('ISSUE1512_LIVE_ROUTING_PG ' + JSON.stringify(pg))
      }
      for (const check of typeChecks) await runCheck(check.label, check.args)
      receipt.verdict = receipt.units.length === unitGroups.length
        && receipt.units.every(row => row.verdict === 'COMPLETE_UNIT_GROUP_PASS')
        && receipt.checks.length === typeChecks.length + 2
        && receipt.checks.every(row => row.verdict === 'CHECK_PASS')
        && receipt.pg?.verdict === 'COMPLETE_CACHE_SCOPE_PG_PASS'
        ? 'ALL_FIXED_SOURCE_GREEN_CHECKS_PASSED' : 'FAILED_OR_BLOCKED'
      if (receipt.verdict !== 'ALL_FIXED_SOURCE_GREEN_CHECKS_PASSED') process.exitCode = 1
    } catch (error) {
      receipt.verdict = 'FAILED_OR_BLOCKED'; receipt.failure = errorProjection(error); process.exitCode = 1
    } finally {
      try { receipt.finalSourceProof = sourceProof('final') }
      catch (error) { receipt.sourceFailure = errorProjection(error); receipt.verdict = 'FINAL_SOURCE_PROOF_FAILED'; process.exitCode = 1 }
      receipt.finishedAt = new Date().toISOString(); persist()
      console.log('ISSUE1512_LIVE_ROUTING_VERDICT ' + JSON.stringify(receipt))
    }
  }
}
