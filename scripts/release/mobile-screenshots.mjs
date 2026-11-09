import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseIdentity, waitForReleaseChecks } from './ci-gate.mjs'

const BUNDLE = 'com.aspectlylabs.mikka'
const ORIGIN = 'https://app.aspectlylabs.com/mikka'
const WORKSPACE = 'e2b57fe1-d831-4f68-a4c8-94c2b68774d3'
const USER = '8f8f435e-0ce2-4bea-965d-afbf508c694f'
const TASK = 'b633a9e7-5f5a-518b-abcd-99eec3cc558c'
const ARTIFACTS = ['97766bd2-4916-5144-adba-f7de75c48398', 'ce9a7c8a-f61b-5617-a5a9-78b806b7b1b5', '1ac28503-b5d2-584a-afac-af29b7cfdcc4']
export const SHOTS = ['01-bots', '02-bot-chat', '03-task', '04-conversation', '05-artifact']

export function screenshotIdentity(env) {
  const identity = releaseIdentity(env)
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(env.GITHUB_REPOSITORY_ID, '1427517699')
  assert.equal(env.GITHUB_REPOSITORY_OWNER_ID, '183887963')
  assert.match(env.OVERLAY_SHA ?? '', /^[a-f0-9]{40}$/)
  return identity
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
  const request = async (path, body) => {
    const response = await fetch(ORIGIN + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', origin: 'https://app.aspectlylabs.com', ...(cookies ? { cookie: cookies } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000), redirect: 'error' })
    assert.equal(response.ok, true, 'demoReadbackHTTPFailed')
    if (path === '/api/auth/sign-in/email') cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    return response.json()
  }
  const english = value => assert.doesNotMatch(JSON.stringify(value), /[\u3400-\u9fff]/)
  try {
    const account = await request('/api/auth/sign-in/email', { email: env.APP_STORE_REVIEW_EMAIL, password: env.APP_STORE_REVIEW_PASSWORD })
    assert.equal(account.user.id, USER)
    assert.ok(cookies, 'reviewSessionRequired')
    // Match the workspace selected through the native Settings screen.
    cookies += `; mikka-workspace=${WORKSPACE}`
    const home = await request('/api/mobile/home')
    assert.equal(home.user.id, USER)
    assert.equal(home.workspace.id, WORKSPACE)
    assert.equal(home.workspace.name, 'Mikka Demo')
    assert.equal(home.bots.length, 4)
    assert.ok(home.bots.every(bot => !bot.working))
    assert.deepEqual(home.threads, { running: 0, waiting: 0 })
    english(home.bots.map(bot => [bot.name, bot.line]))
    const workspace = await request(`/api/workspace?workspace=${WORKSPACE}`)
    assert.equal(workspace.currentUserId, USER)
    assert.equal(workspace.members.length, 1)
    assert.equal(workspace.members[0].userId, USER)
    const artifacts = new Set()
    let messages = 0
    for (const bot of home.bots) {
      const chat = await request(`/api/mobile/chat?bot=${bot.id}`)
      assert.equal(chat.working, false)
      english(chat.items.map(item => item.text))
      messages += chat.items.length
      const metadata = await request(`/api/mobile/bots/${bot.id}`)
      for (const item of metadata.library) artifacts.add(item.id)
    }
    assert.equal(messages, 10)
    assert.deepEqual([...artifacts].sort(), [...ARTIFACTS].sort())
    const tasks = (await request('/api/mobile/tasks')).tasks
    assert.equal(tasks.length, 3)
    const runIds = []
    for (const task of tasks) {
      const detail = await request(`/api/mobile/tasks/${task.id}`)
      assert.equal(detail.live.workspaceId, WORKSPACE)
      english(detail)
      const attempts = detail.activity.filter(item => item.kind === 'attempt')
      assert.equal(attempts.length, 1)
      const thread = await request(`/api/mobile/threads/${attempts[0].runId}`)
      assert.ok(!thread.active && !thread.working && thread.items.length >= 2)
      english(thread)
      runIds.push(attempts[0].runId)
    }
    assert.ok(tasks.some(task => task.id === TASK))
    const launch = home.bots.find(bot => bot.name === 'Atlas Launch')
    assert.ok(launch)
    const artifact = await fetch(`${ORIGIN}/api/artifacts/${ARTIFACTS[2]}/versions/1/download`, {
      headers: { cookie: cookies }, signal: AbortSignal.timeout(30000), redirect: 'error',
    })
    assert.equal(artifact.ok, true)
    const text = await artifact.text()
    assert.ok(text.includes('# Atlas launch checklist'))
    english(text)
    return { botId: launch.id, botIds: home.bots.map(bot => bot.id), taskIds: tasks.map(task => task.id),
      runIds, artifactIds: ARTIFACTS, messages, syntheticDemoContent: true }
  } finally {
    if (cookies) await request('/api/auth/sign-out', {})
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
  const maestro = (name, flow, credentials = false) => {
    const flowPath = join(privateDir, `${name}.yaml`)
    writeFileSync(flowPath, flow, { mode: 0o600 })
    const log = openSync(join(privateDir, `${name}.log`), 'w', 0o600)
    try {
      const result = spawnSync('maestro', ['--device', device.udid, 'test', '--debug-output', join(privateDir, 'debug'),
        '--test-output-dir', join(privateDir, 'driver-output'), flowPath], {
        cwd: privateDir, timeout: 180000, stdio: ['ignore', log, log],
        env: { ...env, MAESTRO_CLI_NO_ANALYTICS: 'true',
          MAESTRO_REVIEW_EMAIL: credentials ? env.APP_STORE_REVIEW_EMAIL : '',
          MAESTRO_REVIEW_PASSWORD: credentials ? env.APP_STORE_REVIEW_PASSWORD : '' },
      })
      assert.equal(result.status, 0, `nativeUIFlowFailed:${name}`)
    } finally { closeSync(log) }
  }
  const backendVersionBefore = await backendVersion()
  const readback = await verifyDemo(env)
  const appPath = join(privateDir, 'build/Build/Products/Release-iphonesimulator/Mikka.app')
  simctl('install', device.udid, appPath)
  simctl('spawn', device.udid, 'defaults', 'write', BUNDLE, 'AppleLanguages', '-array', 'en')
  simctl('spawn', device.udid, 'defaults', 'write', BUNDLE, 'AppleLocale', '-string', 'en_US')
  assert.match(simctl('spawn', device.udid, 'defaults', 'read', 'NSGlobalDomain', 'AppleLanguages'), /en/)
  assert.match(simctl('spawn', device.udid, 'defaults', 'read', BUNDLE, 'AppleLocale'), /en_US/)
  simctl('ui', device.udid, 'appearance', 'light')
  simctl('status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100')
  simctl('launch', device.udid, BUNDLE, '-AppleLanguages', '(en)', '-AppleLocale', 'en_US')
  maestro('login', loginFlow(), true)
  maestro('workspace', workspaceFlow())
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
    maestro(name, readFlow(route, visible))
    const filename = `${name}.png`
    simctl('io', device.udid, 'screenshot', '--type=png', join(output, filename))
    screenshots.push({ filename, ...pngDimensions(readFileSync(join(output, filename))) })
  }
  const backendVersionAfter = await backendVersion(backendVersionBefore)
  const manifest = { backendVersionBefore, backendVersionAfter, sourceSha: identity.sha, overlaySha: env.OVERLAY_SHA, runId: identity.runId,
    capturedAt: new Date().toISOString(), apiOrigin: ORIGIN, workspaceId: WORKSPACE, userId: USER,
    device: device.device, runtime: device.runtime, locale: 'en_US', languages: ['en'], appearance: 'light',
    orientation: 'portrait', dynamicType: 'default', workspaceSelection: 'native Settings local session', build: 'Release iphonesimulator unsigned',
    updatesEnabled: false, authentication: 'normal email sign-in in native UI', ...readback, screenshots }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(output, 'summary.txt'), 'Five full-resolution native simulator screenshots. Demo identity and live API reads verified. Visual review pending.\n')
  assert.deepEqual(readdirSync(output).sort(), [...SHOTS.map(name => `${name}.png`), 'manifest.json', 'summary.txt'].sort())
  appendFileSync(env.GITHUB_STEP_SUMMARY, `Native screenshots captured from ${identity.sha} with overlay ${env.OVERLAY_SHA}. Five PNGs at 1206 × 2622. Visual review pending.\n`)
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
  } else if (mode === 'cleanup') {
    const privateDir = join(env.RUNNER_TEMP, 'mikka-screenshots-private')
    try {
      const device = JSON.parse(readFileSync(join(privateDir, 'device.json'), 'utf8'))
      assert.match(device.udid, /^[A-Fa-f0-9-]{36}$/)
      spawnSync('xcrun', ['simctl', 'shutdown', device.udid], { stdio: 'ignore' })
      execFileSync('xcrun', ['simctl', 'delete', device.udid], { stdio: 'ignore' })
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('screenshotSimulatorCleanupFailed')
    } finally {
      rmSync(privateDir, { recursive: true, force: true })
      rmSync(join(env.RUNNER_TEMP, 'mikka-maestro'), { recursive: true, force: true })
      rmSync('.hosted-ui', { recursive: true, force: true })
      appendFileSync(env.GITHUB_ENV, 'APP_STORE_REVIEW_EMAIL=\nAPP_STORE_REVIEW_PASSWORD=\nHOSTED_UI_READ_KEY=\n')
    }
  } else throw Error('screenshotModeRequired')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv[2]) }
  catch { console.error('Native screenshot step failed. Private diagnostics are excluded from artifacts.'); process.exitCode = 1 }
}
