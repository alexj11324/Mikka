import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { signInBundledAccount } from './bundled-sign-in.mjs'
import { launchElectron } from './electron-launch.mjs'
import { closeElectron, stopLocalDaemons } from './native-cleanup.mjs'

const { IssueThreads: words } = JSON.parse(await readFile(new URL('../../../messages/en.json', import.meta.url), 'utf8'))
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

// Read the response to the installed client's own click. This helper does not
// synthesize a writer request or forward authentication to the controller.
async function clickedWriter(page, button, action) {
  await expect(button).toBeEnabled()
  const [response] = await Promise.all([
    page.waitForResponse(reply => {
      const request = reply.request()
      return new URL(reply.url()).pathname === '/mikka/api/desktop/rpc' &&
        request.method() === 'POST' && request.postDataJSON()?.action === action
    }),
    button.click(),
  ])
  assert.equal(response.status(), 200)
  const ack = await response.json()
  assert.equal(ack.ok, true)
  assert.ok(ack.result && !ack.result.error)
  const [command] = response.request().postDataJSON().args
  return { command, result: ack.result }
}

/** Navigate before releasing the live model turn so that window startup
 * cannot consume the interval in which a human can steer or interrupt. */
export async function openActiveDesktopThread(page, { workspaceId, issueId, runId, ownerId, harness }) {
  assert.ok(['claude_code', 'codex'].includes(harness))
  assert.equal(new URL(page.url()).protocol, 'mikka:')
  const target = new URL('mikka://app/mikka/en/')
  target.search = new URLSearchParams({ workspace: workspaceId, issue: issueId, thread: runId }).toString()
  await page.goto(target.href, { waitUntil: 'domcontentloaded' })
  const picker = page.getByRole('combobox', { name: words.deliveryMode, exact: true })
  const name = words.composer.replace('{agent}', harness === 'codex' ? 'Codex' : 'Claude Code')
  const composer = page.getByRole('textbox', { name, exact: true })

  async function submit(mode, text) {
    const option = picker.getByRole('option', { name: words.deliveryModes[mode], exact: true })
    await expect(option).toHaveCount(1)
    if (harness === 'claude_code') await expect(picker.locator('option[value="steer"]')).toHaveCount(0)
    await picker.selectOption(mode)
    await expect(picker).toHaveValue(mode)
    await composer.fill(text)
    const button = page.getByRole('button', { name: words.send, exact: true }).filter({ visible: true })
    const { command, result } = await clickedWriter(page, button, 'agents.sendIssueThreadReply')
    assert.equal(command.issueId, issueId)
    assert.equal(command.runId, runId)
    assert.equal(command.expectedOwnerId, ownerId)
    assert.equal(command.expectedWorkspaceId, workspaceId)
    assert.equal(command.delivery, mode)
    assert.equal(command.text, text)
    assert.match(command.requestId, uuid)
    assert.deepEqual(result, { sent: true, continued: false, runId })
    return command.requestId
  }

  function queuedRow(text) {
    // A transcript may also contain the same text. Its message lacks the
    // pending row's status and real Cancel button.
    return page.getByText(text, { exact: true }).locator('xpath=parent::*')
      .filter({ has: page.getByText(words.deliveryQueued, { exact: true }) })
      .filter({ has: page.getByRole('button', { name: words.deliveryCancel, exact: true }) })
  }

  async function changeQueued(text, action) {
    assert.ok(['cancel', 'sendNow'].includes(action))
    const label = action === 'cancel' ? words.deliveryCancel : words.deliverySendNow
    const targetRow = queuedRow(text)
    await expect(targetRow).toHaveCount(1)
    const { command, result } = await clickedWriter(page, targetRow.getByRole('button', { name: label, exact: true }), 'agents.changeQueuedThreadReply')
    assert.equal(command.action, action)
    assert.equal(command.issueId, issueId)
    assert.equal(command.runId, runId)
    assert.match(command.messageId, uuid)
    assert.equal(result.status, action === 'cancel' ? 'cancelled' : 'sent')
    return command.messageId
  }

  return {
    submit,
    changeQueued,
    expectDefaultQueue: () => expect(picker).toHaveValue('queue'),
    expectQueued: text => expect(queuedRow(text)).toBeVisible(),
    expectNoPendingRow: text => expect(queuedRow(text)).toHaveCount(0),
  }
}

const qaOrigin = 'https://127.0.0.1:3859'

/** The same official package is used with the isolated HTTPS listener. Its
 * leased web account returns via the existing main-owned native PKCE flow. */
export async function withPackagedDeliveryWindow({ scope, authorityCertificate, workspaceDirectory }, work) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  const revision = process.env.GITHUB_SHA
  assert.match(revision ?? '', /^[a-f0-9]{40}$/)
  const overlay = process.env.MIKKA_UI_OVERLAY_SHA
  assert.match(overlay ?? '', /^[a-f0-9]{40}$/)
  const build = await scope.owner.request('/api/version')
  assert.equal(build.status, 200)
  assert.equal((await build.json()).build, revision)
  const program = resolve(process.env.GITHUB_WORKSPACE, 'apps/desktop/release-acceptance/linux-unpacked/mikka-selfhost-acceptance')
  assert.equal(await realpath(process.env.MIKKA_DESKTOP_EXECUTABLE), await realpath(program))

  const directory = await mkdtemp(join(workspaceDirectory, 'desktop-'))
  const profile = join(directory, 'profile')
  const home = join(directory, 'home')
  const database = join(home, '.pki/nssdb')
  const caFile = await realpath(authorityCertificate)
  const ca = new X509Certificate(await readFile(caFile))
  assert.ok(ca.ca && ca.verify(ca.publicKey))
  const mark = stage => console.log('Desktop delivery qualification:', stage)
  let application, browser, page
  try {
    // Chrome still honors this private NSS DB on new versions. Only the
    // local test CA is imported; the runner's and user's stores stay intact.
    await mkdir(database, { recursive: true, mode: 0o700 })
    execFileSync('certutil', ['-N', '--empty-password', '-d', 'sql:' + database], { stdio: 'ignore' })
    const currentNssRoot = join(home, '.local/share/pki')
    await mkdir(currentNssRoot, { recursive: true, mode: 0o700 })
    await symlink(database, join(currentNssRoot, 'nssdb'), 'dir')
    execFileSync('certutil', ['-A', '-n', 'Mikka local delivery runner', '-t', 'C,,', '-i', caFile, '-d', 'sql:' + database], { stdio: 'ignore' })
    const desktopEnv = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY',
      'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL', 'TMPDIR']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]))
    const env = { ...desktopEnv, HOME: home, NODE_EXTRA_CA_CERTS: caFile, MIKKA_USER_DATA_DIR: profile, MIKKA_DESKTOP_RENDERER: 'bundled' }
    mark('launch-packaged-electron')
    application = await launchElectron({ executablePath: program, env, args: [], timeout: 90_000 })
    const platform = await application.evaluate(async ({ app }) => {
      const fs = process.getBuiltinModule('node:fs')
      const path = process.getBuiltinModule('node:path')
      const archive = app.getAppPath()
      if (!app.isPackaged || archive !== path.join(process.resourcesPath, 'app.asar')) throw Error('Installed archive required')
      const { overlaySha } = JSON.parse(fs.readFileSync(path.join(archive, 'dist', 'mikka-ui-overlay.json'), 'utf8'))
      return { overlaySha, platform: process.platform, arch: process.arch, electron: process.versions.electron, chromium: process.versions.chrome }
    })
    assert.equal(platform.overlaySha, overlay)
    page = await application.firstWindow({ timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.mikka?.bundled))
    const target = qaOrigin + '/mikka'
    mark('select-loopback-https-server')
    const probe = await page.evaluate(url => window.mikka.bundled.server.probe(url), target)
    assert.equal(probe.status, 'ok')
    assert.equal(probe.server.url, target)
    await page.evaluate(url => { void window.mikka.bundled.server.select(url).catch(() => {}) }, target)
    await page.waitForFunction(url => window.mikka?.app.serverUrl === url, target)
    mark('leased-system-browser-login')
    browser = await chromium.launch({ channel: 'chrome', env, chromiumSandbox: true })
    await signInBundledAccount({ application, page, browser, account: scope.owner, scope, origin: qaOrigin, mark })
    return await work({ platform: { revision, ...platform }, openThread: target => openActiveDesktopThread(page, target) })
  } finally {
    try {
      if (page && !page.isClosed()) await page.evaluate(() => window.mikka.bundled.signOut())
    } finally {
      try { await browser?.close() }
      finally {
        await closeElectron(application)
        await stopLocalDaemons([profile])
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
}
