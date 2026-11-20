// Actual packaged Electron → actual disposable community image. The model is
// explicitly synthetic; this is not Google OAuth or native-subscription proof.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decode, encode } from '../../../lib/desktop-rpc/wire.ts'
import { launchElectron } from './electron-launch.mjs'
import { closeElectron, stopLocalDaemons } from './native-cleanup.mjs'
import { verifyDesktopVersionHistory } from './self-hosted-version-history.mjs'
import { verifyWorkspaceAutomation } from './self-hosted-automations.mjs'
import { verifyPersonalDriveUploads } from './self-hosted-drive.mjs'
import { verifyOrganizationLifecycle } from './self-hosted-organization.mjs'
import { verifyConversationOrganization } from './self-hosted-conversations.mjs'
import { waitForBundledSession } from './bundled-session.mjs'
import { verifyInstalledProjectCheckout } from './self-hosted-project-checkout.mjs'
import { prepareLinuxRepositoryDialog, verifyLinuxRepositoryDialog, verifyPickedRepository } from './native-repository-picker.mjs'
import { readNativeStartup } from './native-startup.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function validateSelfHostedDesktopTarget(value, env) {
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/)
  assert.equal(value.revision, env.GITHUB_SHA)
  assert.equal(value.origin, 'http://localhost:3000')
  for (const key of ['workspaceId', 'botId']) assert.match(value[key] ?? '', UUID)
  assert.ok(typeof value.ownerId === 'string' && value.ownerId.length > 0 && value.ownerId.length <= 128)
  assert.match(value.email ?? '', /^selfhost-[a-f0-9-]{36}@selfhost\.example\.test$/i)
  assert.ok(typeof value.password === 'string' && value.password.length >= 24 && value.password.length <= 200)
  if (env.MIKKA_UI_OVERLAY_SHA || value.member) {
    const member = value.member
    assert.ok(member && typeof member.id === 'string' && member.id.length > 0 && member.id.length <= 128)
    assert.match(member.email ?? '', /^selfhost-[a-f0-9-]{36}@selfhost\.example\.test$/i)
    assert.ok(typeof member.password === 'string' && member.password.length >= 24 && member.password.length <= 200)
    if (env.MIKKA_UI_OVERLAY_SHA) {
      assert.match(member.invitation?.id ?? '', UUID)
      assert.match(member.invitation?.organizationId ?? '', UUID)
    }
    assert.ok(member.id !== value.ownerId && member.email !== value.email && member.password !== value.password)
  }
  assert.ok(env.RUNNER_TEMP && env.GITHUB_WORKSPACE && env.MIKKA_DESKTOP_EXECUTABLE)
}

async function main() {
  const directory = resolve(process.env.RUNNER_TEMP, 'mikka-selfhost-desktop')
  const privateFile = join(directory, 'session.json'), profile = join(directory, 'profile')
  const protocolOnly = process.argv.includes('--protocol-only')
  assert.deepEqual(process.argv.slice(2), protocolOnly ? ['--protocol-only'] : [])
  const overlaySha = process.env.MIKKA_UI_OVERLAY_SHA
  if (overlaySha) {
    assert.match(overlaySha, /^[a-f0-9]{40}$/)
    assert.equal(protocolOnly, false)
  }
  const output = resolve('.artifacts/self-hosted/desktop')
  await mkdir(output, { recursive: true })
  const report = { schemaVersion: 1, revision: process.env.GITHUB_SHA, origin: 'http://localhost:3000',
    startedAt: new Date().toISOString(), status: 'running', checks: [],
    scope: protocolOnly ? 'public-fixture-protocol' : 'complete-desktop', overlaySha: overlaySha ?? null,
    provider: 'synthetic-openai-compatible', realGoogleOAuth: false, subscriptionAcceptance: false,
    cleanup: { session: false, electron: false, daemon: false, privateFile: false } }
  let application, page, fixture, phase = 'private_fixture', failed
  const passed = name => report.checks.push(name)
  async function rpc(action, args) {
    const value = await page.evaluate(async body => {
      const response = await fetch('/mikka/api/desktop/rpc', { method: 'POST', credentials: 'omit',
        headers: { 'content-type': 'application/json', 'x-mikka-desktop-protocol': '1' }, body })
      return { status: response.status, body: await response.json() }
    }, JSON.stringify({ version: 1, action, args: encode(args) }))
    assert.equal(value.status, 200); assert.equal(value.body.ok, true)
    const result = decode(value.body.result)
    assert.ok(!result?.error)
    return result
  }
  try {
    const info = await stat(privateFile)
    assert.equal(info.mode & 0o777, 0o600)
    fixture = JSON.parse(await readFile(privateFile, 'utf8'))
    validateSelfHostedDesktopTarget(fixture, process.env)
    await rm(privateFile); report.cleanup.privateFile = true
    const target = fixture.origin + '/mikka'
    phase = 'launch'
    const linuxPicker = overlaySha && process.platform === 'linux' && process.env.MIKKA_TEST_X11_DIRECTORY_DIALOG === '1'
      ? await prepareLinuxRepositoryDialog(profile) : null
    application = await launchElectron({ executablePath: process.env.MIKKA_DESKTOP_EXECUTABLE,
      args: [], cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: { ...process.env, ...(linuxPicker ? { XDG_CONFIG_HOME: linuxPicker.config } : {}), MIKKA_USER_DATA_DIR: profile, MIKKA_DESKTOP_RENDERER: 'bundled' }, timeout: 90_000 })
    if (overlaySha) {
      phase = 'packaged_official_overlay'
      const runtime = await application.evaluate(async ({ app }, expected) => {
        const path = process.getBuiltinModule('node:path')
        const fs = process.getBuiltinModule('node:fs')
        const archive = app.getAppPath()
        if (!app.isPackaged || archive !== path.join(process.resourcesPath, 'app.asar')) return null
        const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'dist', 'mikka-ui-overlay.json'), 'utf8'))
        if (manifest.overlaySha !== expected) return null
        return { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome,
          platform: process.platform, architecture: process.arch }
      }, overlaySha)
      assert.ok(runtime?.app && runtime.electron && runtime.chromium, 'the launched official application must contain the selected UI revision')
      report.runtime = runtime
      passed('packaged_official_overlay_matches_selected_revision')
    }
    page = await application.firstWindow({ timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.mikka?.bundled))
    assert.equal(new URL(page.url()).protocol, 'mikka:')
    phase = 'discovery_and_selection'
    const probe = await page.evaluate(url => window.mikka.bundled.server.probe(url), target)
    assert.equal(probe.status, 'ok'); assert.equal(probe.server.url, target)
    await page.evaluate(url => { void window.mikka.bundled.server.select(url).catch(() => {}) }, target)
    await page.waitForFunction(url => window.mikka?.app.serverUrl === url, target)
    assert.equal((await page.evaluate(() => window.mikka.bundled.server.state())).current.cloud, false)
    passed('real_community_discovery_and_explicit_server_selection')
    phase = 'email_sign_in'
    const login = await page.evaluate(value => window.mikka.bundled.signInEmail(value), { email: fixture.email, password: fixture.password })
    assert.equal(login, null)
    const session = await waitForBundledSession(page, fixture.ownerId)
    assert.equal(session.user.id, fixture.ownerId)
    const bootstrap = await rpc('desktop.bootstrap', [fixture.workspaceId])
    assert.equal(bootstrap.edition, 'community'); assert.equal(bootstrap.user.id, fixture.ownerId)
    passed('normal_email_login_and_authenticated_remote_rpc')
    phase = 'builtin_live'
    await page.evaluate(async workspace => {
      const state = { ready: false, chatEvents: 0, failed: false }
      window.__selfHostedAcceptance = state
      const channel = await window.mikka.bundled.live.prepare(workspace)
      if (!channel?.id || Object.keys(channel).some(key => !['id', 'expiresAt'].includes(key))) throw Error('private_live_handle_invalid')
      state.id = channel.id
      state.unsubscribe = window.mikka.bundled.live.onEvent(event => {
        if (event.id !== state.id) return
        if (event.type === 'close' || event.type === 'error') state.failed = true
        if (event.type !== 'message') return
        let data
        try { data = JSON.parse(event.data) } catch { return }
        if (data.type === 'live_ready') state.ready = true
        if (data.kind === 'bot_chat') state.chatEvents++
      })
      await window.mikka.bundled.live.connect(channel.id)
    }, fixture.workspaceId)
    await page.waitForFunction(() => window.__selfHostedAcceptance.ready || window.__selfHostedAcceptance.failed)
    assert.equal(await page.evaluate(() => window.__selfHostedAcceptance.failed), false)
    passed('actual_builtin_live_ticket_and_socket')
    phase = 'chat_reply'
    const accepted = await page.evaluate(async input => {
      const response = await fetch(`/mikka/api/agents/eve/v1/session?botId=${input.botId}`, {
        method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-mikka-submission-id': input.submissionId },
        body: JSON.stringify({ message: 'selfhost_turn_32', clientContext: { expectedOwnerId: input.ownerId, expectedWorkspaceId: input.workspaceId } }),
      })
      return { status: response.status, body: await response.json() }
    }, { botId: fixture.botId, ownerId: fixture.ownerId, workspaceId: fixture.workspaceId, submissionId: randomUUID() })
    assert.equal(accepted.status, 202); assert.equal(accepted.body.ok, true)
    assert.match(accepted.body.sessionId, /^wrun_/); assert.ok(accepted.body.deliveryId)
    const deadline = Date.now() + 60_000
    for (;;) {
      const before = await page.evaluate(() => window.__selfHostedAcceptance.chatEvents)
      const chat = await rpc('coordinator.pollCoordinatorChat', [fixture.botId])
      assert.ok(chat.enabled === true && !chat.error)
      if (!chat.working && JSON.stringify(chat.items).includes('SELF_HOSTED_REPLY_32')) break
      assert.ok(Date.now() < deadline)
      await page.waitForFunction(count => window.__selfHostedAcceptance.chatEvents > count || window.__selfHostedAcceptance.failed,
        before, { timeout: Math.max(1, deadline - Date.now()) })
      assert.equal(await page.evaluate(() => window.__selfHostedAcceptance.failed), false)
    }
    assert.ok(await page.evaluate(() => window.__selfHostedAcceptance.chatEvents > 0))
    passed('real_chat_submission_and_fixture_reply_over_live_invalidations')
    await page.evaluate(async () => {
      const state = window.__selfHostedAcceptance
      state.unsubscribe(); await window.mikka.bundled.live.close(state.id)
      delete window.__selfHostedAcceptance
    })
    phase = 'open_workspace'
    assert.equal(bootstrap.onboarding, true, 'the new account still requires its ordinary first-run setup')
    const workspace = new URL('mikka://app/mikka/en/')
    workspace.searchParams.set('workspace', fixture.workspaceId)
    // The public directory hosts the ordinary guide without loading the
    // official-only bot overview. The full client opens the actual chat.
    if (protocolOnly) workspace.searchParams.set('section', 'conversations')
    else workspace.searchParams.set('bot', fixture.botId)
    await page.goto(workspace.href, { waitUntil: 'domcontentloaded' })
    // A newly registered community account still has the ordinary first-run
    // overlay. A DOM-visible chat underneath it is not screenshot evidence.
    // Complete the real Skip setup action; never hide or remove the overlay.
    phase = 'first_run_skip_button_visible'
    const skipSetup = page.getByRole('button', { name: 'Skip setup', exact: true })
    await skipSetup.waitFor({ state: 'visible' })
    phase = 'first_run_dismissal'
    await skipSetup.click()
    await skipSetup.waitFor({ state: 'hidden' })
    assert.equal((await rpc('desktop.bootstrap', [fixture.workspaceId])).onboarding, false,
      'the real Skip setup action must persist for this account')
    passed('normal_first_run_dismissed')
    if (!protocolOnly) {
      phase = 'fixture_reply_visible'
      const reply = page.getByText('SELF_HOSTED_REPLY_32', { exact: false }).first()
      await reply.waitFor({ state: 'visible' })
      await reply.scrollIntoViewIfNeeded()
      passed('normal_first_run_dismissed_and_reply_visible')
      const screenshot = await page.screenshot({ path: join(output, 'self-hosted-chat.png'), animations: 'disabled' })
      report.visibleChatScreenshotSha256 = createHash('sha256').update(screenshot).digest('hex')
    }
    if (overlaySha) {
      phase = 'conversation_owner_member'
      const controls = { page, fixture, rpc, passed, setPhase: value => { phase = value } }
      const sharedWorkspace = await verifyConversationOrganization(controls)
      await verifyOrganizationLifecycle({ ...controls, workspaceId: sharedWorkspace })
      report.driveFolder = {}
      report.driveUploads = []
      await verifyPersonalDriveUploads({ ...controls, application, workspaceId: sharedWorkspace, directory, folderCheck: report.driveFolder, receipts: report.driveUploads })
      report.versionAdmissions = await verifyDesktopVersionHistory(controls)
      await verifyWorkspaceAutomation({ ...controls, workspaceId: sharedWorkspace })
      phase = 'native_repository_picker'
      if (linuxPicker) {
        await verifyLinuxRepositoryDialog(page, linuxPicker, async (root, choose) => {
          phase = 'project_checkout'
          report.projectCheckout = await verifyInstalledProjectCheckout({ page, rpc, workspaceId: sharedWorkspace, root, choose })
          passed('installed_project_choose_native_git_root_read_after_reload_and_clear')
        })
        passed('packaged_linux_gtk_selects_nested_git_roots_and_cancels_over_native_ipc')
      } else {
        await verifyPickedRepository(application, page, directory)
        passed('packaged_repository_picker_resolves_origin_and_upstream_with_fixture_dialog_selection')
      }
    }
    phase = 'sign_out_and_return'
    await page.evaluate(() => window.mikka.bundled.signOut())
    assert.equal(await page.evaluate(() => window.mikka.bundled.session()), null)
    report.cleanup.session = true
    await page.evaluate(() => { void window.mikka.bundled.server.select(null).catch(() => {}) })
    await page.waitForFunction(() => window.mikka?.app.serverUrl === 'http://localhost:3001/mikka')
    passed('sign_out_and_return_to_bundled_default_server')
    report.status = 'passed'
  } catch (error) {
    failed = error; report.status = 'failed'; report.failure = { phase, name: error instanceof Error ? error.name : 'UnknownError' }
    if (page && fixture && ['open_workspace', 'first_run_skip_button_visible', 'first_run_dismissal', 'fixture_reply_visible'].includes(phase)) {
      // Retain only observations about this generated fixture. Raw DOM, URLs,
      // request bodies and exception messages can contain credentials.
      report.failure.view = await page.evaluate(({ botId, workspaceId }) => {
        const url = new URL(location.href)
        return {
          requestedWorkspace: url.searchParams.get('workspace') === workspaceId,
          requestedBot: url.searchParams.get('bot') === botId,
          english: document.documentElement.lang === 'en',
          skipButtonPresent: [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Skip setup'),
          loading: Boolean(document.querySelector('[data-loading-placeholder]')),
          offline: Boolean(document.querySelector('.desktop-offline')),
          renderFailed: document.body.innerText.includes('This view could not open'),
          composer: Boolean(document.querySelector('textarea[data-chat-composer]')),
          expectedReply: document.body.innerText.includes('SELF_HOSTED_REPLY_32'),
        }
      }, { botId: fixture.botId, workspaceId: fixture.workspaceId }).catch(() => null)
      report.failure.startup = await readNativeStartup(application, page).catch(() => null)
    }
  } finally {
    if (page && !report.cleanup.session) {
      try { await page.evaluate(() => window.mikka?.bundled.signOut()); report.cleanup.session = true } catch { report.cleanup.session = false }
    }
    try { await closeElectron(application); report.cleanup.electron = true } catch { report.cleanup.electron = false }
    if (report.cleanup.electron) {
      try { await stopLocalDaemons([profile]); report.cleanup.daemon = true } catch { report.cleanup.daemon = false }
    }
    try { await rm(privateFile, { force: true }); report.cleanup.privateFile = true } catch { report.cleanup.privateFile = false }
    if (!Object.values(report.cleanup).every(Boolean)) report.status = 'failed'
    if (report.cleanup.electron && report.cleanup.daemon) await rm(profile, { recursive: true, force: true })
    report.finishedAt = new Date().toISOString()
    const json = JSON.stringify(report, null, 2)
    if (fixture) for (const secret of [fixture.password, fixture.email, fixture.member?.password, fixture.member?.email]) {
      if (secret) assert.ok(!json.includes(secret))
    }
    await writeFile(join(output, 'report.json'), json + '\n')
  }
  console.log(JSON.stringify({ scope: report.scope, overlaySha: report.overlaySha, status: report.status, checks: report.checks, cleanup: report.cleanup, failure: report.failure }))
  if (failed || report.status !== 'passed') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() } catch { console.error('SELF_HOSTED_DESKTOP_DRIVER_FAILED'); process.exitCode = 1 }
}
