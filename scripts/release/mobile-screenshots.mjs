import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants } from 'node:os'
import { releaseIdentity, waitForReleaseChecks } from './ci-gate.mjs'

const BUNDLE = 'com.aspectlylabs.mikka'
const ORIGIN = 'https://app.aspectlylabs.com/mikka'
const WORKSPACE = 'e2b57fe1-d831-4f68-a4c8-94c2b68774d3'
const USER = '8f8f435e-0ce2-4bea-965d-afbf508c694f'
const TASK = 'b633a9e7-5f5a-518b-abcd-99eec3cc558c'
const ARTIFACTS = ['97766bd2-4916-5144-adba-f7de75c48398', 'ce9a7c8a-f61b-5617-a5a9-78b806b7b1b5', '1ac28503-b5d2-584a-afac-af29b7cfdcc4']
export const SHOTS = ['01-bots', '02-bot-chat', '03-task', '04-conversation', '05-artifact']
export const MAESTRO_CHILD_TIMEOUT_MS = 600000

const PHASES = new Set(['source', 'capture', 'cleanup', 'driver-preflight', 'native-driver-preflight', 'simulator-create', 'simulator-boot-initial',
  'simulator-system-locale', 'simulator-boot-localized', 'backend-version-before', 'demo-readback',
  'demo-auth-sign-in', 'demo-home', 'demo-workspace', 'demo-bot-chat', 'demo-bot-metadata', 'demo-tasks',
  'demo-task-detail', 'demo-thread', 'demo-artifact', 'demo-auth-sign-out', 'simulator-install',
  'simulator-app-locale', 'simulator-appearance', 'simulator-status-bar', 'simulator-launch',
  'native-login', 'native-workspace', 'backend-version-after', 'manifest',
  ...SHOTS.flatMap(name => [`native-${name}`, `png-${name}`])])
const ERROR_NAMES = new Set(['Error', 'AssertionError', 'TypeError', 'SyntaxError', 'RangeError',
  'AbortError', 'TimeoutError', 'SystemError'])
const ERROR_CODES = new Set(['ERR_ASSERTION', 'ERR_INVALID_ARG_TYPE', 'ERR_OUT_OF_RANGE',
  'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ENOMEM', 'ENOBUFS', 'ETIMEDOUT', 'ECONNREFUSED',
  'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'NATIVE_UI_FLOW_FAILED'])
const CHECKS = new Set(['backendVersionHTTPFailed', 'backendVersionSHARequired', 'backendOverlaySHARequired',
  'backendDeploymentChangedDuringCapture', 'demoReadbackHTTPFailed', 'reviewSessionRequired',
  'existingReviewCredentialRequired', 'screenshotSimulatorCleanupFailed', 'screenshotModeRequired',
  'iPhone17ProAndIOS26Required', 'preflightCredentialBoundaryRequired', 'driverPreflightCIRequired',
  'driverPreflightIdentityRequired'])
const NATIVE_FLOWS = new Set(['driver-preflight', 'login', 'workspace', ...SHOTS])
const COMMAND_TYPES = ['applyConfigurationCommand', 'launchAppCommand', 'assertConditionCommand',
  'tapOnElement', 'inputTextCommand', 'hideKeyboardCommand']
const COMMAND_STATUSES = new Set(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'WARNED', 'SKIPPED'])
const SIGN_IN_SELECTORS = new Set(['signin-email', 'signin-password', 'signin-submit'])

export function nativeDriverFlow() {
  return 'appId: com.apple.Preferences\n---\n- launchApp\n- assertVisible: Settings\n'
}

export function nativeFlowDiagnostics(privateDir, name) {
  assert.ok(NATIVE_FLOWS.has(name))
  const result = { reason: 'unknown', commandReport: 'missing', commands: [] }
  try {
    if (readFileSync(join(privateDir, `${name}.log`), 'utf8').includes('iOS driver not ready in time')) {
      result.reason = 'ios_driver_startup_timeout'
    }
  } catch { result.logReadFailed = true }
  try {
    // Maestro cli-2.12.1 writes <timestamp>/<known-flow[-collision]>/commands.json.
    const output = join(privateDir, 'driver-output')
    const timestamps = readdirSync(output, { withFileTypes: true })
    assert.ok(timestamps.length <= 32)
    const reports = []
    for (const timestamp of timestamps) {
      if (!timestamp.isDirectory() || !/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(timestamp.name)) continue
      const directory = join(output, timestamp.name)
      const flows = readdirSync(directory, { withFileTypes: true })
      assert.ok(flows.length <= 32)
      for (const flow of flows) {
        if (flow.isDirectory() && new RegExp(`^${name}(?:-(?:[2-9]|[1-9]\\d+))?$`).test(flow.name)) {
          reports.push(join(directory, flow.name, 'commands.json'))
        }
      }
    }
    if (reports.length !== 1) {
      result.commandReport = reports.length ? 'ambiguous' : 'missing'
      return result
    }
    const records = JSON.parse(readFileSync(reports[0], 'utf8'))
    assert.ok(Array.isArray(records) && records.length <= 256)
    result.commands = records.map(record => {
      const command = record.command ?? {}
      const metadata = record.metadata ?? {}
      const type = COMMAND_TYPES.find(key => command[key] != null) ?? 'unknown'
      const projected = { type, status: COMMAND_STATUSES.has(metadata.status) ? metadata.status : 'unknown',
        errorPresent: metadata.error != null }
      for (const [key, value] of [['sequenceNumber', metadata.sequenceNumber], ['durationMs', metadata.duration]]) {
        if (Number.isSafeInteger(value) && value >= 0) projected[key] = value
      }
      const selector = command.tapOnElement?.selector?.idRegex ?? command.assertConditionCommand?.condition?.visible?.idRegex
        ?? command.assertConditionCommand?.condition?.notVisible?.idRegex
      if (SIGN_IN_SELECTORS.has(selector)) projected.selectorId = selector
      const message = metadata.error?.message
      if (result.reason === 'unknown' && metadata.status === 'FAILED' && typeof message === 'string') {
        if (message.startsWith('Assertion is false:')) result.reason = 'assertion_failed'
        else if (message.startsWith('Element not found:') || message.startsWith('No visible element found:')) result.reason = 'element_not_found'
      }
      return projected
    })
    result.commandReport = 'available'
  } catch (error) {
    result.commandReport = error.code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  return result
}

function nativeFlow(env, device, privateDir, name, flow, credentials = false) {
  assert.ok(NATIVE_FLOWS.has(name))
  return screenshotPhase(`native-${name}`, () => {
    const flowPath = join(privateDir, `${name}.yaml`)
    writeFileSync(flowPath, flow, { mode: 0o600 })
    const log = openSync(join(privateDir, `${name}.log`), 'w', 0o600)
    let result
    try {
      result = spawnSync('maestro', ['--device', device.udid, 'test', '--debug-output', join(privateDir, 'debug'),
        '--test-output-dir', join(privateDir, 'driver-output'), flowPath], {
        cwd: privateDir, timeout: MAESTRO_CHILD_TIMEOUT_MS, stdio: ['ignore', log, log],
        env: { ...env, MAESTRO_CLI_NO_ANALYTICS: 'true', MAESTRO_DRIVER_STARTUP_TIMEOUT: '300000',
          MAESTRO_REVIEW_EMAIL: credentials ? env.APP_STORE_REVIEW_EMAIL : '',
          MAESTRO_REVIEW_PASSWORD: credentials ? env.APP_STORE_REVIEW_PASSWORD : '' },
      })
    } finally { closeSync(log) }
    if (result.status !== 0) {
      console.log(`native-screenshot-flow-failure ${JSON.stringify({ phase: `native-${name}`, ...nativeFlowDiagnostics(privateDir, name) })}`)
      throw Object.assign(new Error('nativeUIFlowFailed', { cause: result.error }), {
        code: 'NATIVE_UI_FLOW_FAILED', status: result.status, signal: result.signal,
        timedOut: result.error?.code === 'ETIMEDOUT',
      })
    }
  })
}

// Never serialize Error objects, messages, commands, stdout, stderr or assertion values.
export function screenshotFailure(error) {
  const failure = { errorName: ERROR_NAMES.has(error?.name) ? error.name : 'UnknownError' }
  if (ERROR_CODES.has(error?.code)) failure.errorCode = error.code
  const check = typeof error?.message === 'string' ? error.message.split('\n', 1)[0] : undefined
  if (CHECKS.has(check)) failure.check = check
  if (Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255) failure.exitCode = error.status
  if (Object.hasOwn(constants.signals, error?.signal ?? '')) failure.signal = constants.signals[error.signal]
  if (typeof error?.timedOut === 'boolean') failure.timedOut = error.timedOut
  if (error?.code === 'ETIMEDOUT') failure.timedOut = true
  if (ERROR_NAMES.has(error?.cause?.name)) failure.causeName = error.cause.name
  if (ERROR_CODES.has(error?.cause?.code)) failure.causeCode = error.cause.code
  return failure
}

export async function screenshotPhase(phase, operation, log = console.log) {
  assert.ok(PHASES.has(phase), 'screenshotPhaseRequired')
  const start = Date.now()
  const emit = (event, detail = {}) => log(`native-screenshot-phase ${JSON.stringify({
    phase, event, at: new Date().toISOString(), elapsedMs: Date.now() - start, ...detail,
  })}`)
  emit('start')
  try {
    const value = await operation()
    emit('success')
    return value
  } catch (error) {
    emit('failure', screenshotFailure(error))
    throw error
  }
}

export function screenshotIdentity(env) {
  const identity = releaseIdentity(env)
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(env.GITHUB_REPOSITORY_ID, '1427517699')
  assert.equal(env.GITHUB_REPOSITORY_OWNER_ID, '183887963')
  assert.match(env.OVERLAY_SHA ?? '', /^[a-f0-9]{40}$/)
  return identity
}

export function driverPreflightIdentity(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'driverPreflightCIRequired')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'driverPreflightIdentityRequired')
  assert.equal(env.GITHUB_REPOSITORY, 'alexj11324/Mikka', 'driverPreflightIdentityRequired')
  assert.equal(env.GITHUB_REPOSITORY_ID, '1427517699', 'driverPreflightIdentityRequired')
  assert.equal(env.GITHUB_REPOSITORY_OWNER_ID, '183887963', 'driverPreflightIdentityRequired')
  assert.match(env.GITHUB_REF ?? '', /^refs\/heads\/[^\s]+$/, 'driverPreflightIdentityRequired')
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'driverPreflightIdentityRequired')
  assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/, 'driverPreflightIdentityRequired')
  return { sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, ref: env.GITHUB_REF }
}

export async function backendVersion(expected, fetchImpl = fetch) {
  const response = await fetchImpl(`${ORIGIN}/api/version`, { cache: 'no-store', credentials: 'omit',
    redirect: 'error', headers: { 'cache-control': 'no-store' }, signal: AbortSignal.timeout(30000) })
  assert.equal(response.ok, true, 'backendVersionHTTPFailed')
  const data = await response.json()
  assert.match(data.build ?? '', /^[a-f0-9]{40}$/, 'backendVersionSHARequired')
  assert.ok(data.overlaySha === null || /^[a-f0-9]{40}$/.test(data.overlaySha ?? ''), 'backendOverlaySHARequired')
  const version = { build: data.build, overlaySha: data.overlaySha }
  if (expected) assert.deepEqual(version, expected, 'backendDeploymentChangedDuringCapture')
  return version
}

export function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(bytes.subarray(12, 16).toString(), 'IHDR')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  assert.equal(width, 1206)
  assert.equal(height, 2622)
  return { width, height }
}

export function loginFlow() {
  return `appId: ${BUNDLE}
---
- launchApp
- extendedWaitUntil:
    visible:
      id: signin-email
    timeout: 60000
- tapOn:
    id: signin-email
- inputText: \${MAESTRO_REVIEW_EMAIL}
- tapOn:
    id: signin-password
- inputText: \${MAESTRO_REVIEW_PASSWORD}
- hideKeyboard
- tapOn:
    id: signin-submit
- extendedWaitUntil:
    notVisible:
      id: signin-submit
    timeout: 60000
`
}

export function workspaceFlow() {
  return `appId: ${BUNDLE}
---
- openLink: mikka://settings/workspaces
- extendedWaitUntil:
    visible: Mikka Demo
    timeout: 60000
- tapOn: Mikka Demo
- openLink: mikka://
- extendedWaitUntil:
    visible: Atlas Research
    timeout: 60000
- waitForAnimationToEnd
`
}

export function readFlow(route, visible) {
  assert.match(route, /^mikka:\/\/(?:bots\/|task\/|artifact\/|$)/)
  return `appId: ${BUNDLE}
---
- openLink: ${JSON.stringify(route)}
- extendedWaitUntil:
    visible: ${JSON.stringify(visible)}
    timeout: 60000
- waitForAnimationToEnd
`
}

async function verifyDemo(env) {
  let cookies = ''
  const request = async (phase, path, body) => screenshotPhase(phase, async () => {
    const response = await fetch(ORIGIN + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', origin: 'https://app.aspectlylabs.com', ...(cookies ? { cookie: cookies } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000), redirect: 'error' })
    assert.equal(response.ok, true, 'demoReadbackHTTPFailed')
    if (path === '/api/auth/sign-in/email') cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    return response.json()
  })
  const english = value => assert.doesNotMatch(JSON.stringify(value), /[\u3400-\u9fff]/)
  try {
    const account = await request('demo-auth-sign-in', '/api/auth/sign-in/email', { email: env.APP_STORE_REVIEW_EMAIL, password: env.APP_STORE_REVIEW_PASSWORD })
    assert.equal(account.user.id, USER)
    assert.ok(cookies, 'reviewSessionRequired')
    // Match the workspace selected through the native Settings screen.
    cookies += `; mikka-workspace=${WORKSPACE}`
    const home = await request('demo-home', '/api/mobile/home')
    assert.equal(home.user.id, USER)
    assert.equal(home.workspace.id, WORKSPACE)
    assert.equal(home.workspace.name, 'Mikka Demo')
    assert.equal(home.bots.length, 4)
    assert.ok(home.bots.every(bot => !bot.working))
    assert.deepEqual(home.threads, { running: 0, waiting: 0 })
    english(home.bots.map(bot => [bot.name, bot.line]))
    const workspace = await request('demo-workspace', `/api/workspace?workspace=${WORKSPACE}`)
    assert.equal(workspace.currentUserId, USER)
    assert.equal(workspace.members.length, 1)
    assert.equal(workspace.members[0].userId, USER)
    const artifacts = new Set()
    let messages = 0
    for (const bot of home.bots) {
      const chat = await request('demo-bot-chat', `/api/mobile/chat?bot=${bot.id}`)
      assert.equal(chat.working, false)
      english(chat.items.map(item => item.text))
      messages += chat.items.length
      const metadata = await request('demo-bot-metadata', `/api/mobile/bots/${bot.id}`)
      for (const item of metadata.library) artifacts.add(item.id)
    }
    assert.equal(messages, 10)
    assert.deepEqual([...artifacts].sort(), [...ARTIFACTS].sort())
    const tasks = (await request('demo-tasks', '/api/mobile/tasks')).tasks
    assert.equal(tasks.length, 3)
    const runIds = []
    for (const task of tasks) {
      const detail = await request('demo-task-detail', `/api/mobile/tasks/${task.id}`)
      assert.equal(detail.live.workspaceId, WORKSPACE)
      english(detail)
      const attempts = detail.activity.filter(item => item.kind === 'attempt')
      assert.equal(attempts.length, 1)
      const thread = await request('demo-thread', `/api/mobile/threads/${attempts[0].runId}`)
      assert.ok(!thread.active && !thread.working && thread.items.length >= 2)
      english(thread)
      runIds.push(attempts[0].runId)
    }
    assert.ok(tasks.some(task => task.id === TASK))
    const launch = home.bots.find(bot => bot.name === 'Atlas Launch')
    assert.ok(launch)
    const text = await screenshotPhase('demo-artifact', async () => {
      const artifact = await fetch(`${ORIGIN}/api/artifacts/${ARTIFACTS[2]}/versions/1/download`, {
        headers: { cookie: cookies }, signal: AbortSignal.timeout(30000), redirect: 'error',
      })
      assert.equal(artifact.ok, true)
      return artifact.text()
    })
    assert.ok(text.includes('# Atlas launch checklist'))
    english(text)
    return { botId: launch.id, botIds: home.bots.map(bot => bot.id), taskIds: tasks.map(task => task.id),
      runIds, artifactIds: ARTIFACTS, messages, syntheticDemoContent: true }
  } finally {
    if (cookies) await request('demo-auth-sign-out', '/api/auth/sign-out', {})
  }
}

async function capture(env) {
  const identity = screenshotIdentity(env)
  for (const name of ['APP_STORE_REVIEW_EMAIL', 'APP_STORE_REVIEW_PASSWORD']) {
    assert.ok(env[name], 'existingReviewCredentialRequired')
    console.log(`::add-mask::${env[name]}`)
  }
  const privateDir = join(env.RUNNER_TEMP, 'mikka-screenshots-private')
  const output = join(env.RUNNER_TEMP, 'mikka-app-store-export')
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { mode: 0o700 })
  const device = JSON.parse(readFileSync(join(privateDir, 'device.json'), 'utf8'))
  const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const maestro = (name, flow, credentials = false) => nativeFlow(env, device, privateDir, name, flow, credentials)
  const backendVersionBefore = await screenshotPhase('backend-version-before', () => backendVersion())
  const readback = await screenshotPhase('demo-readback', () => verifyDemo(env))
  const appPath = join(privateDir, 'build/Build/Products/Release-iphonesimulator/Mikka.app')
  await screenshotPhase('simulator-install', () => simctl('install', device.udid, appPath))
  await screenshotPhase('simulator-app-locale', () => {
    simctl('spawn', device.udid, 'defaults', 'write', BUNDLE, 'AppleLanguages', '-array', 'en')
    simctl('spawn', device.udid, 'defaults', 'write', BUNDLE, 'AppleLocale', '-string', 'en_US')
    assert.match(simctl('spawn', device.udid, 'defaults', 'read', 'NSGlobalDomain', 'AppleLanguages'), /en/)
    assert.match(simctl('spawn', device.udid, 'defaults', 'read', BUNDLE, 'AppleLocale'), /en_US/)
  })
  await screenshotPhase('simulator-appearance', () => simctl('ui', device.udid, 'appearance', 'light'))
  await screenshotPhase('simulator-status-bar', () => simctl('status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100'))
  await screenshotPhase('simulator-launch', () => simctl('launch', device.udid, BUNDLE, '-AppleLanguages', '(en)', '-AppleLocale', 'en_US'))
  await maestro('login', loginFlow(), true)
  await maestro('workspace', workspaceFlow())
  const routes = [
    ['mikka://', 'Atlas Research'],
    [`mikka://bots/${readback.botId}`, '.*The checklist is ready to review.*'],
    [`mikka://task/${TASK}`, 'Review the launch checklist'],
    [`mikka://task/${TASK}/conversation`, '.*The checklist is ready to review.*'],
    [`mikka://artifact/${ARTIFACTS[2]}?v=1&title=Atlas%20launch%20checklist`, '.*Review the welcome flow.*'],
  ]
  const screenshots = []
  for (const [index, [route, visible]] of routes.entries()) {
    const name = SHOTS[index]
    await maestro(name, readFlow(route, visible))
    const filename = `${name}.png`
    await screenshotPhase(`png-${name}`, () => {
      simctl('io', device.udid, 'screenshot', '--type=png', join(output, filename))
      screenshots.push({ filename, ...pngDimensions(readFileSync(join(output, filename))) })
    })
  }
  const backendVersionAfter = await screenshotPhase('backend-version-after', () => backendVersion(backendVersionBefore))
  await screenshotPhase('manifest', () => {
    const manifest = { backendVersionBefore, backendVersionAfter, sourceSha: identity.sha, overlaySha: env.OVERLAY_SHA, runId: identity.runId,
      capturedAt: new Date().toISOString(), apiOrigin: ORIGIN, workspaceId: WORKSPACE, userId: USER,
      device: device.device, runtime: device.runtime, locale: 'en_US', languages: ['en'], appearance: 'light',
      orientation: 'portrait', dynamicType: 'default', workspaceSelection: 'native Settings local session', build: 'Release iphonesimulator unsigned',
      updatesEnabled: false, authentication: 'normal email sign-in in native UI', ...readback, screenshots }
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    writeFileSync(join(output, 'summary.txt'), 'Five full-resolution native simulator screenshots. Demo identity and live API reads verified. Visual review pending.\n')
    assert.deepEqual(readdirSync(output).sort(), [...SHOTS.map(name => `${name}.png`), 'manifest.json', 'summary.txt'].sort())
    appendFileSync(env.GITHUB_STEP_SUMMARY, `Native screenshots captured from ${identity.sha} with overlay ${env.OVERLAY_SHA}. Five PNGs at 1206 × 2622. Visual review pending.\n`)
  })
}

async function main(mode) {
  const env = process.env
  assert.ok(env.RUNNER_TEMP)
  if (mode === 'source') {
    const identity = screenshotIdentity(env)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), identity.sha)
    await waitForReleaseChecks(identity, { token: env.GITHUB_TOKEN })
  } else if (mode === 'capture') {
    await capture(env)
  } else if (mode === 'driver-preflight') {
    driverPreflightIdentity(env)
    assert.ok(!env.APP_STORE_REVIEW_EMAIL && !env.APP_STORE_REVIEW_PASSWORD && !env.HOSTED_UI_READ_KEY,
      'preflightCredentialBoundaryRequired')
    const privateDir = join(env.RUNNER_TEMP, 'mikka-screenshots-private')
    const device = JSON.parse(readFileSync(join(privateDir, 'device.json'), 'utf8'))
    await nativeFlow(env, device, privateDir, 'driver-preflight', nativeDriverFlow())
  } else if (mode === 'cleanup') {
    const privateDir = join(env.RUNNER_TEMP, 'mikka-screenshots-private')
    try {
      const device = JSON.parse(readFileSync(join(privateDir, 'device.json'), 'utf8'))
      assert.match(device.udid, /^[A-Fa-f0-9-]{36}$/)
      spawnSync('xcrun', ['simctl', 'shutdown', device.udid], { stdio: 'ignore' })
      execFileSync('xcrun', ['simctl', 'delete', device.udid], { stdio: 'ignore' })
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('screenshotSimulatorCleanupFailed', { cause: error })
    } finally {
      rmSync(privateDir, { recursive: true, force: true })
      rmSync(join(env.RUNNER_TEMP, 'mikka-maestro'), { recursive: true, force: true })
      rmSync('.hosted-ui', { recursive: true, force: true })
      appendFileSync(env.GITHUB_ENV, 'APP_STORE_REVIEW_EMAIL=\nAPP_STORE_REVIEW_PASSWORD=\nHOSTED_UI_READ_KEY=\n')
    }
  } else throw Error('screenshotModeRequired')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await screenshotPhase(process.argv[2], () => main(process.argv[2])) }
  catch { process.exitCode = 1 }
}
