import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, constants } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { screenshotIdentity, pngDimensions, loginFlow, workspaceFlow, readFlow, backendVersion,
  screenshotFailure, screenshotPhase, nativeDriverFlow, nativeFlowDiagnostics,
  driverPreflightIdentity, MAESTRO_CHILD_TIMEOUT_MS, SHOTS } from './mobile-screenshots.mjs'

const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123',
  GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963', OVERLAY_SHA: 'b'.repeat(40) }

test('manual main identity and full overlay revision are required before credentials', () => {
  assert.equal(screenshotIdentity(env).sha, env.GITHUB_SHA)
  for (const patch of [{ GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'fork/Mikka' }, { GITHUB_REPOSITORY_ID: 'other' },
    { GITHUB_REPOSITORY_OWNER_ID: 'other' }, { OVERLAY_SHA: 'main' }, { OVERLAY_SHA: 'b'.repeat(39) }]) {
    assert.throws(() => screenshotIdentity({ ...env, ...patch }))
  }
})

test('PNG validation accepts only the actual full-resolution capture size', () => {
  const png = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
  png.write('IHDR', 12)
  png.writeUInt32BE(1206, 16)
  png.writeUInt32BE(2622, 20)
  assert.deepEqual(pngDimensions(png), { width: 1206, height: 2622 })
  png.writeUInt32BE(1320, 16)
  png.writeUInt32BE(2868, 20)
  assert.throws(() => pngDimensions(png))
})

test('only login inputs use secret placeholders and post-authentication flows only navigate and wait', () => {
  const login = loginFlow()
  assert.match(login, /inputText: \$\{MAESTRO_REVIEW_PASSWORD\}/)
  assert.match(login, /id: signin-submit/)
  const flow = readFlow('mikka://task/demo/conversation', 'Checklist')
  assert.doesNotMatch(flow, /inputText|tapOn|runScript|evalScript|http|launchApp/)
  assert.throws(() => readFlow('https://example.com', 'Demo'))
  assert.equal(SHOTS.length, 5)
  assert.match(workspaceFlow(), /tapOn: Mikka Demo/)
  assert.doesNotMatch(workspaceFlow(), /inputText|runScript|http/)
})

test('workflow credentials follow source and CI validation and exports remain allowlisted', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-screenshots.yml', import.meta.url), 'utf8')
  const source = workflow.indexOf('run: node scripts/release/mobile-screenshots.mjs source')
  const credential = workflow.indexOf('uses: Infisical/secrets-action@')
  assert.ok(source > 0 && credential > source)
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/)
  assert.doesNotMatch(workflow, /pull_request:|push:|secrets\.|continue-on-error/)
  assert.equal((workflow.match(/secret-name:/g) ?? []).length, 3)
  assert.match(workflow, /secret-name: APP_STORE_REVIEW_EMAIL/)
  assert.match(workflow, /secret-name: APP_STORE_REVIEW_PASSWORD/)
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/mikka-app-store-export\//)
  assert.ok(workflow.indexOf('Build unsigned Release') < workflow.indexOf('Read existing review email'))
  const build = readFileSync(new URL('./mobile-screenshots-build.sh', import.meta.url), 'utf8')
  assert.match(build, /item\.name === 'iPhone 17 Pro'/)
  assert.match(build, /CODE_SIGNING_ALLOWED=NO/)
  assert.match(build, /Set :EXUpdatesEnabled false/)
})


test('backend provenance reads the live version without cache and rejects deployment drift', async () => {
  const before = { build: 'c'.repeat(40), overlaySha: 'd'.repeat(40) }
  const read = data => async (url, init) => {
    assert.equal(url, 'https://app.aspectlylabs.com/mikka/api/version')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'error')
    return Response.json({ ...data, privateField: 'excluded from manifest' })
  }
  assert.deepEqual(await backendVersion(undefined, read(before)), before)
  assert.deepEqual(await backendVersion(before, read(before)), before)
  for (const after of [{ ...before, build: 'e'.repeat(40) }, { ...before, overlaySha: null }]) {
    await assert.rejects(backendVersion(before, read(after)), /backendDeploymentChangedDuringCapture/)
  }
  await assert.rejects(backendVersion(undefined, read({ build: 'unknown', overlaySha: null })), /backendVersionSHARequired/)
  await assert.rejects(backendVersion(undefined, read({ ...before, overlaySha: 'main' })), /backendOverlaySHARequired/)
  await assert.rejects(backendVersion(undefined, async () => new Response('', { status: 503 })), /backendVersionHTTPFailed/)
})

test('failure diagnostics preserve closed error and child metadata without private values', () => {
  const cause = Object.assign(new Error('private child stderr and command'), { code: 'ETIMEDOUT' })
  const error = Object.assign(new Error('private email password cookie', { cause }), {
    code: 'NATIVE_UI_FLOW_FAILED', status: null, signal: 'SIGTERM', timedOut: true,
    stdout: 'private stdout', stderr: 'private stderr', path: '/private/credential',
  })
  assert.deepEqual(screenshotFailure(error), { errorName: 'Error', errorCode: 'NATIVE_UI_FLOW_FAILED',
    signal: constants.signals.SIGTERM, timedOut: true, causeName: 'Error', causeCode: 'ETIMEDOUT' })
  assert.deepEqual(screenshotFailure(Object.assign(error, { status: 7 })), {
    errorName: 'Error', errorCode: 'NATIVE_UI_FLOW_FAILED', exitCode: 7,
    signal: constants.signals.SIGTERM, timedOut: true, causeName: 'Error', causeCode: 'ETIMEDOUT',
  })
  assert.deepEqual(screenshotFailure({ name: 'private name', code: 'private code', message: 'private message',
    signal: 'private signal', status: 123456789, timedOut: 'private value',
    cause: { name: 'private cause', code: 'private cause code' } }), { errorName: 'UnknownError' })
  for (const check of ['backendVersionHTTPFailed', 'backendDeploymentChangedDuringCapture']) {
    assert.throws(() => assert.deepEqual({ private: 'actual response' }, { private: 'expected response' }, check), error => {
      assert.deepEqual(screenshotFailure(error), { errorName: 'AssertionError', errorCode: 'ERR_ASSERTION', check })
      assert.doesNotMatch(JSON.stringify(screenshotFailure(error)), /private|actual response|expected response/)
      return true
    })
  }
})

test('phase diagnostics time each outcome and rethrow the original failure without serializing it', async () => {
  const lines = []
  const log = line => lines.push(JSON.parse(line.replace(/^native-screenshot-phase /, '')))
  assert.equal(await screenshotPhase('native-login', () => 'private return value', log), 'private return value')
  const error = Object.assign(new Error('private password'), { code: 'ENOENT', status: 127 })
  await assert.rejects(screenshotPhase('native-workspace', async () => { throw error }, log), value => value === error)
  assert.deepEqual(lines.map(row => [row.phase, row.event]), [
    ['native-login', 'start'], ['native-login', 'success'], ['native-workspace', 'start'], ['native-workspace', 'failure'],
  ])
  for (const row of lines) {
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)
  }
  assert.equal(lines[3].errorCode, 'ENOENT')
  assert.equal(lines[3].exitCode, 127)
  assert.doesNotMatch(JSON.stringify(lines), /private/)
  await assert.rejects(screenshotPhase('private phase', () => {}, log), /screenshotPhaseRequired/)
  assert.equal(lines.length, 4)
})

test('build phase diagnostics retain only the exit status while command output stays private', () => {
  const build = readFileSync(new URL('./mobile-screenshots-build.sh', import.meta.url), 'utf8')
  const helper = build.match(/^run_build_phase\(\) \{[\s\S]*?^\}/m)?.[0]
  assert.ok(helper)
  const directory = mkdtempSync(join(tmpdir(), 'mikka-screenshot-diagnostics-'))
  mkdirSync(join(directory, 'mikka-screenshots-private'))
  try {
    const result = spawnSync('bash', ['-c', `${helper}\nrun_build_phase xcodebuild bash -c 'echo private-command-output; echo private-stderr >&2; exit 7'`], {
      encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: directory },
    })
    assert.equal(result.status, 7)
    assert.equal(result.stderr, '')
    assert.doesNotMatch(result.stdout, /private-command-output|private-stderr|bash -c/)
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line.replace(/^native-screenshot-phase /, '')))
    assert.equal(rows[0].event, 'start')
    assert.equal(rows[1].event, 'failure')
    assert.equal(rows[1].phase, 'xcodebuild')
    assert.equal(rows[1].exitCode, 7)
    assert.equal(rows[1].errorCode, 'BUILD_CHILD_EXIT')
    assert.match(readFileSync(join(directory, 'mikka-screenshots-private/xcodebuild.log'), 'utf8'), /private-command-output/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('stock native driver preflight runs before compilation and reviewer credential reads', () => {
  assert.equal(nativeDriverFlow(), 'appId: com.apple.Preferences\n---\n- launchApp\n- assertVisible: Settings\n')
  const build = readFileSync(new URL('./mobile-screenshots-build.sh', import.meta.url), 'utf8')
  const preflight = build.indexOf('node scripts/release/mobile-screenshots.mjs driver-preflight')
  assert.ok(preflight > build.indexOf("screenshotPhase('simulator-boot-localized'"))
  assert.ok(preflight < build.indexOf('cd apps/mobile'))
  assert.ok(preflight < build.indexOf('run_build_phase expo-prebuild'))
  assert.ok(build.indexOf('if [ "${1:-}" = --preflight-only ]; then exit 0; fi') > preflight)
  assert.ok(build.indexOf('if [ "${1:-}" = --preflight-only ]; then exit 0; fi') < build.indexOf('cd apps/mobile'))
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-screenshots.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('Build unsigned Release') < workflow.indexOf('Read existing review email'))
})

test('driver startup fits within the shared outer budget while UI waits retain sixty seconds', () => {
  assert.equal(MAESTRO_CHILD_TIMEOUT_MS, 600000)
  for (const flow of [loginFlow(), workspaceFlow(), readFlow('mikka://task/demo', 'Checklist')]) {
    const timeouts = [...flow.matchAll(/timeout: (\d+)/g)].map(match => Number(match[1]))
    assert.ok(timeouts.length > 0)
    assert.ok(timeouts.every(timeout => timeout === 60000))
  }
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-screenshots.yml', import.meta.url), 'utf8')
  const probe = workflow.slice(workflow.indexOf('\n  driver-preflight:\n'))
  assert.match(probe, /timeout-minutes: 25/)
  assert.match(workflow.slice(0, workflow.indexOf('\n  driver-preflight:\n')), /timeout-minutes: 120/)
})

test('driver preflight rejects existing credentials and invokes only the stock flow without them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-driver-preflight-'))
  const privateDir = join(directory, 'mikka-screenshots-private')
  const binaryDir = join(directory, 'bin')
  mkdirSync(privateDir)
  mkdirSync(binaryDir)
  writeFileSync(join(privateDir, 'device.json'), JSON.stringify({ udid: 'fixture-device' }))
  writeFileSync(join(binaryDir, 'maestro'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.PROBE_CAPTURE, JSON.stringify({ args: process.argv.slice(2),
  driverStartupTimeout: process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT,
  credentialsPresent: ['APP_STORE_REVIEW_EMAIL', 'APP_STORE_REVIEW_PASSWORD', 'HOSTED_UI_READ_KEY',
    'MAESTRO_REVIEW_EMAIL', 'MAESTRO_REVIEW_PASSWORD'].some(name => Boolean(process.env[name])) }))
console.log('FAKE_PRIVATE_DRIVER_OUTPUT')
`, { mode: 0o700 })
  const module = fileURLToPath(new URL('./mobile-screenshots.mjs', import.meta.url))
  const childEnv = { ...process.env, ...env, GITHUB_ACTIONS: 'true', RUNNER_TEMP: directory, PATH: `${binaryDir}:${process.env.PATH}`,
    APP_STORE_REVIEW_EMAIL: '', APP_STORE_REVIEW_PASSWORD: '', HOSTED_UI_READ_KEY: '', PROBE_CAPTURE: join(directory, 'probe.json') }
  try {
    for (const credential of ['APP_STORE_REVIEW_EMAIL', 'APP_STORE_REVIEW_PASSWORD', 'HOSTED_UI_READ_KEY']) {
      const rejected = spawnSync(process.execPath, [module, 'driver-preflight'], {
        encoding: 'utf8', env: { ...childEnv, [credential]: 'FAKE_PRIVATE_CREDENTIAL' },
      })
      assert.equal(rejected.status, 1)
      assert.match(rejected.stdout, /preflightCredentialBoundaryRequired/)
      assert.doesNotMatch(rejected.stdout + rejected.stderr, /FAKE_PRIVATE_CREDENTIAL/)
      assert.equal(readdirSync(privateDir).includes('driver-preflight.yaml'), false)
    }
    const accepted = spawnSync(process.execPath, [module, 'driver-preflight'], { encoding: 'utf8', env: childEnv })
    assert.equal(accepted.status, 0)
    assert.match(accepted.stdout, /"phase":"native-driver-preflight","event":"success"/)
    assert.doesNotMatch(accepted.stdout + accepted.stderr, /FAKE_PRIVATE_DRIVER_OUTPUT/)
    assert.equal(readFileSync(join(privateDir, 'driver-preflight.yaml'), 'utf8'), nativeDriverFlow())
    assert.match(readFileSync(join(privateDir, 'driver-preflight.log'), 'utf8'), /FAKE_PRIVATE_DRIVER_OUTPUT/)
    const invocation = JSON.parse(readFileSync(join(directory, 'probe.json'), 'utf8'))
    assert.equal(invocation.credentialsPresent, false)
    assert.equal(invocation.driverStartupTimeout, '300000')
    assert.equal(invocation.args.at(-1), join(privateDir, 'driver-preflight.yaml'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('read-only branch preflight validates CI identity while screenshot identity still requires main', () => {
  const branch = { ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/fix/native-driver-preflight' }
  assert.equal(driverPreflightIdentity(branch).ref, branch.GITHUB_REF)
  assert.equal(driverPreflightIdentity({ ...branch, GITHUB_REF: 'refs/heads/main' }).sha, branch.GITHUB_SHA)
  assert.throws(() => screenshotIdentity(branch))
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'fork/Mikka' }, { GITHUB_REPOSITORY_ID: 'other' },
    { GITHUB_REPOSITORY_OWNER_ID: 'other' }, { GITHUB_REF: 'refs/pull/1/merge' },
    { GITHUB_REF: 'refs/heads/' }, { GITHUB_SHA: 'main' }, { GITHUB_RUN_ID: 'invalid' }]) {
    assert.throws(() => driverPreflightIdentity({ ...branch, ...patch }))
  }
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-screenshots.yml', import.meta.url), 'utf8')
  const probe = workflow.slice(workflow.indexOf('\n  driver-preflight:\n'))
  assert.match(probe, /github\.ref != 'refs\/heads\/main'/)
  assert.match(probe, /startsWith\(github\.ref, 'refs\/heads\/'\)/)
  assert.match(probe, /permissions:\n      contents: read\n/)
  assert.match(probe, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(probe, /gh release download cli-2\.12\.1 --repo mobile-dev-inc\/Maestro --pattern maestro\.zip --pattern checksums_sha256\.txt/)
  assert.match(probe, /shasum -a 256 -c checksums_sha256\.txt/)
  assert.match(probe, /mobile-screenshots-build\.sh --preflight-only/)
  assert.match(probe, /if: always\(\)\n        run: node scripts\/release\/mobile-screenshots\.mjs cleanup/)
  assert.doesNotMatch(probe, /id-token|Infisical|secrets\.|environment:|APP_STORE|HOSTED_UI|OVERLAY|upload-artifact|pnpm|GITHUB_REF:/)
})

test('both pinned installers use the official CLI with read-only token delivery and private download logs', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-screenshots.yml', import.meta.url), 'utf8')
  const download = /gh release download cli-2\.12\.1 --repo mobile-dev-inc\/Maestro --pattern maestro\.zip --pattern checksums_sha256\.txt > download\.log 2>&1/g
  assert.equal([...workflow.matchAll(download)].length, 2)
  assert.equal([...workflow.matchAll(/GH_TOKEN: \$\{\{ github\.token \}\}/g)].length, 2)
  assert.equal([...workflow.matchAll(/shasum -a 256 -c checksums_sha256\.txt/g)].length, 2)
  assert.doesNotMatch(workflow, /location-trusted|GH_DEBUG|--retry|echo.*GH_TOKEN|GH_TOKEN=.*GITHUB_ENV/)
})

test('pinned Maestro command reports project only closed command metadata and fixed failure reasons', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-maestro-report-'))
  const reportDir = join(directory, 'driver-output', '2026-11-09_061500', 'login-2')
  mkdirSync(reportDir, { recursive: true })
  const log = join(directory, 'login.log')
  const report = join(reportDir, 'commands.json')
  const records = [
    { command: { applyConfigurationCommand: { env: { PASSWORD: 'FAKE_PRIVATE_CREDENTIAL' } } },
      metadata: { status: 'COMPLETED', sequenceNumber: 0, duration: 1 } },
    { command: { inputTextCommand: { text: 'FAKE_PRIVATE_CREDENTIAL' } }, metadata: {
      status: 'COMPLETED', sequenceNumber: 1, duration: 50, evaluatedCommand: { text: 'FAKE_PRIVATE_CREDENTIAL' },
      artifacts: { screenshot: 'FAKE_PRIVATE_PATH' },
    } },
    { command: { assertConditionCommand: { condition: { visible: { idRegex: 'signin-email' } } } },
      metadata: { status: 'FAILED', sequenceNumber: 2, duration: 60000,
        error: { message: 'Assertion is false: FAKE_PRIVATE_HIERARCHY', debugMessage: 'FAKE_PRIVATE_CREDENTIAL' } } },
    { command: { FAKE_PRIVATE_COMMAND: {} }, metadata: { status: 'FAKE_PRIVATE_STATUS',
      sequenceNumber: 'FAKE_PRIVATE_SEQUENCE', duration: 'FAKE_PRIVATE_DURATION' } },
  ]
  try {
    writeFileSync(log, 'FAKE_PRIVATE_CHILD_OUTPUT')
    writeFileSync(report, JSON.stringify(records))
    const projection = nativeFlowDiagnostics(directory, 'login')
    assert.deepEqual(projection, { reason: 'assertion_failed', commandReport: 'available', commands: [
      { type: 'applyConfigurationCommand', status: 'COMPLETED', errorPresent: false, sequenceNumber: 0, durationMs: 1 },
      { type: 'inputTextCommand', status: 'COMPLETED', errorPresent: false, sequenceNumber: 1, durationMs: 50 },
      { type: 'assertConditionCommand', status: 'FAILED', errorPresent: true, sequenceNumber: 2, durationMs: 60000, selectorId: 'signin-email' },
      { type: 'unknown', status: 'unknown', errorPresent: false },
    ] })
    assert.doesNotMatch(JSON.stringify(projection), /FAKE_PRIVATE/)
    for (const message of ['Element not found: FAKE_PRIVATE', 'No visible element found: FAKE_PRIVATE']) {
      records[2].metadata.error.message = message
      writeFileSync(report, JSON.stringify(records))
      assert.equal(nativeFlowDiagnostics(directory, 'login').reason, 'element_not_found')
    }
    writeFileSync(log, 'iOS driver not ready in time, consider increasing timeout by configuring MAESTRO_DRIVER_STARTUP_TIMEOUT env variable\nFAKE_PRIVATE')
    rmSync(report)
    assert.deepEqual(nativeFlowDiagnostics(directory, 'login'), {
      reason: 'ios_driver_startup_timeout', commandReport: 'missing', commands: [],
    })
    writeFileSync(log, 'FAKE_PRIVATE unknown failure')
    assert.deepEqual(nativeFlowDiagnostics(directory, 'login'), { reason: 'unknown', commandReport: 'missing', commands: [] })
    writeFileSync(report, 'FAKE_PRIVATE malformed JSON')
    assert.deepEqual(nativeFlowDiagnostics(directory, 'login'), { reason: 'unknown', commandReport: 'unreadable', commands: [] })
    writeFileSync(report, JSON.stringify(records))
    mkdirSync(join(directory, 'driver-output', '2026-11-09_061500', 'login'))
    assert.deepEqual(nativeFlowDiagnostics(directory, 'login'), { reason: 'unknown', commandReport: 'ambiguous', commands: [] })
    assert.throws(() => nativeFlowDiagnostics(directory, 'FAKE_PRIVATE_FLOW'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
