// TEMPORARY acceptance-branch orchestration. Never import this from application code.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// This fixed run covers the existing local prerequisites and the official
// cloud task leg. The plan is embedded in the remote program, not caller input.
export const acceptancePlan = Object.freeze({
  items: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
  softTimeout: 85 * 60_000,
  killTimeout: 88 * 60_000,
  hardTimeout: 90 * 60_000,
  cleanupGrace: 60_000,
})

export const target = Object.freeze({
  api: 'https://api.vercel.com',
  teamId: 'team_C7lwxVVvnUicFli6112mvxpv',
  projectId: 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',
  projectName: 'mikka',
  sessionId: 'sbx_qjiHsJWkPvJAC8afDreaZn5T4CFV',
  cwd: '/vercel/mikka-local-loop',
  hardTimeout: acceptancePlan.hardTimeout,
})

export function requirePinnedSource(git, sha, root) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')
    || git('rev-parse', '--show-toplevel') !== root
    || git('rev-parse', 'HEAD') !== sha
    || git('status', '--porcelain', '--untracked-files=normal') !== '') {
    throw new Error('sandbox_source_rejected')
  }
}

// This program executes only inside the existing, independently provisioned VM.
// Its source and the immutable SHA are ordinary arguments; neither contains secrets.
export const sandboxProgram = String.raw`
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { resolve } from 'node:path'

const root = '/vercel/mikka-local-loop'
const sha = process.argv[1]
const acceptancePlan = ${JSON.stringify(acceptancePlan)}
let child
let log
let lock
let evidenceDir
let stopped = false
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
${requirePinnedSource.toString()}
const requireSource = () => requirePinnedSource(git, sha, root)
function stopChild() {
  stopped = true
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
}
try {
  process.umask(0o077)
  assert.match(sha ?? '', /^[a-f0-9]{40}$/)
  assert.equal(Number(process.versions.node.split('.')[0]), 24)
  assert.equal(await realpath(process.cwd()), root)
  for (const name of ['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_RUN_ID', 'VERCEL', 'VERCEL_ENV']) {
    assert.ok(!process.env[name], 'Independent local sandbox environment required')
  }
  assert.notEqual(process.env.NODE_ENV, 'production')
  assert.notEqual(process.env.LOCAL_LOOP_HOLD, '1')
  assert.notEqual(process.env.MIKKA_DEV_SKIP_DAEMON, '1')
  assert.ok(!process.env.MIKKA_TEST_ENVIRONMENT_FILE, 'A fresh attestation is required')
  assert.ok(process.env.DEEPSEEK_API_KEY?.trim())
  assert.ok(process.env.E2B_API_KEY?.trim())
  if (process.getuid?.() === 0) {
    assert.match(process.env.MIKKA_DEV_DAEMON_USER ?? '', /^[a-z_][a-z0-9_-]{0,31}$/)
    assert.notEqual(execFileSync('id', ['-u', process.env.MIKKA_DEV_DAEMON_USER], { encoding: 'utf8' }).trim(), '0')
  }
  requireSource()
  execFileSync(process.execPath, ['scripts/assert-test-model.mjs', 'deepseek-flash'], { cwd: root, stdio: 'pipe' })
  // The driver itself fingerprints these tracked directories. Only ignored cache
  // files may be written here; no checkout/install/source mutation follows.
  execFileSync('git', ['check-ignore', '-q', '.cache/dev-local/acceptance-dispatch.lock'], { cwd: root, stdio: 'pipe' })
  await mkdir(resolve(root, '.cache/dev-local'), { recursive: true, mode: 0o700 })
  lock = await open(resolve(root, '.cache/dev-local/acceptance-dispatch.lock'), 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ sha, pid: process.pid, startedAt: new Date().toISOString() }))
  const portProbe = net.createServer()
  await new Promise((yes, no) => { portProbe.once('error', no); portProbe.listen(3112, '127.0.0.1', yes) })
  await new Promise((yes, no) => portProbe.close(error => error ? no(error) : yes()))
  const password = (await readFile('/var/lib/mikka-dev/e2e-password', 'utf8')).trim()
  assert.ok(password && !/[\r\n\0]/.test(password))
  const db = new URL('postgresql://e2e@127.0.0.1:5432/mikka_e2e')
  db.password = password
  evidenceDir = resolve(root, '.cache/dev-local', 'dispatch-' + sha.slice(0, 12) + '-' + randomUUID())
  await mkdir(evidenceDir, { mode: 0o700 })
  log = await open(resolve(evidenceDir, 'local-loop.log'), 'wx', 0o600)
  const env = {
    ...process.env,
    MIKKA_LOCAL_TEST_ACCOUNTS: '1',
    E2E_DATABASE_URL: db.href,
    DATABASE_URL: db.href,
    MIKKA_DATABASE_URL: db.href,
    LOCAL_LOOP_ITEMS: acceptancePlan.items.join(','),
    LOCAL_LOOP_EXPECTED_SOURCE_SHA: sha,
    LOCAL_LOOP_ORIGIN: 'http://localhost:3112',
    MIKKA_DEV_PORT: '3112',
    MIKKA_DEV_SKIP_ENV_FILES: '1',
  }
  // Do not add --existing: the normal driver creates and migrates a new *_e2e
  // database and signs up/signs in ordinary TestAccountPool accounts itself.
  child = spawn(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', 'scripts/dev-local/acceptance.mjs'], {
    cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd],
  })
  const softTimer = setTimeout(stopChild, acceptancePlan.softTimeout)
  const killTimer = setTimeout(() => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }, acceptancePlan.killTimeout)
  process.once('SIGTERM', stopChild)
  process.once('SIGINT', stopChild)
  const result = await new Promise((yes, no) => {
    child.once('error', no)
    child.once('exit', (code, signal) => yes({ code, signal }))
  }).finally(() => { clearTimeout(softTimer); clearTimeout(killTimer) })
  child = undefined
  requireSource()
  const passed = result.code === 0 && !result.signal && !stopped
  await writeFile(resolve(evidenceDir, 'dispatch-result.json'), JSON.stringify({
    sourceSha: sha, items: acceptancePlan.items, status: passed ? 'passed' : 'failed',
    exitCode: result.code, interrupted: stopped, completedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 })
  process.exitCode = passed ? 0 : 1
} catch {
  stopChild()
  process.exitCode = 1
} finally {
  await log?.close().catch(() => {})
  if (lock) {
    await lock.close().catch(() => {})
    // Only the process that acquired this exclusive file can remove it.
    const { unlink } = await import('node:fs/promises')
    await unlink(resolve(root, '.cache/dev-local/acceptance-dispatch.lock')).catch(() => {})
  }
}
`

class DispatchError extends Error {}
const fail = code => { throw new DispatchError(code) }
const hasSecret = value => typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value)
const commandId = value => typeof value === 'string' && /^cmd_[a-zA-Z0-9]+$/.test(value)

export async function run({ env = process.env, fetchImpl = fetch, report = value => console.log(JSON.stringify(value)), sleep = delay, now = Date.now } = {}) {
  let cmdId = null
  try {
    if (env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || env.GITHUB_REF !== 'refs/heads/acceptance/proactive-1157-1163'
      || env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.GITHUB_EVENT_NAME !== 'push') fail('runner_boundary_rejected')
    const sha = env.MIKKA_ACCEPTANCE_SOURCE_SHA
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) fail('source_sha_required')
    if (!hasSecret(env.VERCEL_TEAM_TOKEN) || !hasSecret(env.DEEPSEEK_API_KEY) || !hasSecret(env.E2B_API_KEY)) fail('credential_missing')
    const waitPending = Symbol('wait_pending')
    const request = async (path, body, waitForExit = false) => {
      const url = new URL(path, target.api)
      url.searchParams.set('teamId', target.teamId)
      const signal = AbortSignal.timeout(15_000)
      let response
      try {
        response = await fetchImpl(url, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: 'Bearer ' + env.VERCEL_TEAM_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error', signal,
        })
      } catch (error) {
        // Only a read-only wait may be repeated. A lost POST response never is.
        if (!body && waitForExit && (signal.aborted || error?.name === 'TimeoutError')) return waitPending
        fail(body ? 'submission_unknown_no_retry' : 'provider_request_failed')
      }
      if (!response.ok) fail(body ? 'submission_rejected' : 'provider_request_rejected')
      try { return await response.json() } catch (error) {
        if (!body && waitForExit && (signal.aborted || error?.name === 'TimeoutError')) return waitPending
        fail(body ? 'submission_unknown_no_retry' : 'provider_response_invalid')
      }
    }
    const project = await request('/v9/projects/' + target.projectId)
    if (project.id !== target.projectId || project.accountId !== target.teamId || project.name !== target.projectName) fail('project_boundary_rejected')
    const { session } = await request('/v2/sandboxes/sessions/' + target.sessionId)
    if (session?.id !== target.sessionId || session.projectId !== target.projectId || session.status !== 'running') fail('sandbox_boundary_rejected')
    if (!Number.isFinite(session.startedAt) || !Number.isFinite(session.timeout)
      || session.startedAt + session.timeout - now() < target.hardTimeout + acceptancePlan.cleanupGrace) fail('sandbox_lifetime_insufficient')
    // No retries: a lost submission response must never duplicate a paid loop.
    const { command } = await request('/v2/sandboxes/sessions/' + target.sessionId + '/cmd', {
      command: 'node', args: ['--input-type=module', '--eval', sandboxProgram, sha],
      cwd: target.cwd, env: { DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY, E2B_API_KEY: env.E2B_API_KEY },
      // The API rejects any logs field when wait is false, including logs:false.
      timeout: target.hardTimeout, wait: false, sudo: false,
    })
    if (!commandId(command?.id) || command.sessionId !== target.sessionId) fail('submission_unknown_no_retry')
    cmdId = command.id
    report({ cmdId, status: 'submitted' })
    const deadline = now() + target.hardTimeout + acceptancePlan.cleanupGrace
    let latest = command
    while (latest.exitCode === null || latest.exitCode === undefined) {
      if (now() >= deadline) fail('command_wait_timeout')
      await sleep(10_000)
      if (now() >= deadline) fail('command_wait_timeout')
      // wait=false can retain the submission's null exitCode even after exit.
      // wait=true reads completion; its bounded HTTP timeout does not resubmit.
      const data = await request('/v2/sandboxes/sessions/' + target.sessionId + '/cmd/' + cmdId + '?wait=true', undefined, true)
      if (data === waitPending) continue
      latest = data?.command
      if (latest?.id !== cmdId || latest.sessionId !== target.sessionId) fail('command_boundary_rejected')
    }
    if (!Number.isInteger(latest.exitCode)) fail('command_response_invalid')
    const status = latest.exitCode === 0 ? 'passed' : 'failed'
    report({ cmdId, status })
    return { cmdId, status, exitCode: latest.exitCode === 0 ? 0 : 1 }
  } catch (error) {
    const status = error instanceof DispatchError ? error.message : 'dispatch_failed'
    report({ cmdId, status })
    return { cmdId, status, exitCode: 1 }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = (await run()).exitCode
