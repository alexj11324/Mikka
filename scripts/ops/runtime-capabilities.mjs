import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TARGET, assertExecutionScope, verifiedSource } from './subscription-inventory.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const ID = /^[1-9][0-9]{0,24}$/
const CODES = new Set(['scope', 'source', 'account', 'request', 'body', 'version', 'deployment', 'signin', 'cookie', 'session', 'github', 'github_scope', 'permissions', 'devices', 'projection', 'logout', 'unknown'])
const fail = code => { const error = Error('capability_' + code); error.code = code; throw error }
const errorCode = error => CODES.has(error?.code) ? 'capability_' + error.code : 'capability_unknown'
const assert = (condition, code) => { if (!condition) fail(code) }

async function json(response) {
  const reader = response.body?.getReader()
  assert(reader, 'body')
  const buffers = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 512 * 1024) { await reader.cancel(); fail('body') }
      buffers.push(value)
    }
    return JSON.parse(Buffer.concat(buffers).toString('utf8'))
  } catch { fail('body') }
}

export function projectGitHub(value, userId) {
  assert(value?.viewerId === userId, 'github_scope')
  assert(typeof value.configured === 'boolean' && typeof value.connected === 'boolean' && typeof value.installed === 'boolean'
    && Array.isArray(value.repositories) && value.repositories.length <= 5000, 'github')
  const repositories = value.repositories.slice(0, 100).map(repository => {
    assert(ID.test(repository?.id ?? '') && typeof repository.private === 'boolean'
      && typeof repository.fullName === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.fullName)
      && repository.fullName.length <= 201 && repository.fullName.split('/').every(part => !['.', '..'].includes(part) && !part.startsWith('-')), 'github')
    const publicUrl = `https://github.com/${repository.fullName}`
    assert(repository.htmlUrl === publicUrl, 'github')
    return { repositoryId: repository.id, private: repository.private, authorized: true,
      repositoryHash: createHash('sha256').update(repository.fullName.toLowerCase()).digest('hex'),
      ...(repository.private ? {} : { publicUrl }) }
  })
  return { ownerVerified: true, configured: value.configured, connected: value.connected, installed: value.installed,
    repositoryCount: value.repositories.length, repositories, truncated: value.repositories.length > 100,
    isolatedRepositoryVerified: false, writePermissionVerified: false }
}

export function projectPermissions(value, userId) {
  assert(value?.viewerId === userId, 'github_scope')
  assert(['allow', 'ask', 'deny'].includes(value.push) && ['allow', 'deny'].includes(value.pullRequest), 'permissions')
  return { ownerVerified: true, storedPush: value.push, storedPullRequest: value.pullRequest, legacyStoredPermissionsOnly: true }
}

export function projectDevices(value) {
  assert(Array.isArray(value?.devices) && value.devices.length <= 1000, 'devices')
  const devices = value.devices.slice(0, 100).map(device => {
    assert(UUID.test(device?.id ?? '') && ['cloud', 'laptop', 'server'].includes(device.kind) && typeof device.online === 'boolean', 'devices')
    return { id: device.id, kind: device.kind, online: device.online }
  })
  return { ownerScope: 'authenticated-owner', count: value.devices.length, devices, truncated: value.devices.length > 100,
    onlineCount: value.devices.filter(device => device.online === true).length,
    registrationOrHarnessReadinessVerified: false }
}

/** Read-only capability snapshot. Only normal sign-in/sign-out use POST. */
export async function runRuntimeCapabilities({ env = process.env, fetchImpl = fetch, verifySource = verifiedSource, now = () => new Date().toISOString() } = {}) {
  try { assertExecutionScope(env) } catch { fail('scope') }
  const source = await verifySource()
  assert(source?.revision === TARGET.revision && typeof source.isSmokeAccountEmail === 'function', 'source')
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  assert(source.isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'account')
  const secrets = new Set()
  const remember = value => {
    if (typeof value === 'string' && value) for (const item of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) secrets.add(item)
  }
  remember(email); remember(password)
  const cookies = new Map()
  const report = { schemaVersion: 1, status: 'failed', sourceRevision: TARGET.revision, expectedDeployment: TARGET.deployment,
    startedAt: now(), completedAt: null, versionBefore: null, versionAfter: null, getRequests: 0,
    authentication: { loginStatus: null, sessionVerified: false, signOutStatus: null, sessionEnded: false },
    github: null, permissions: null, devices: null, errors: [],
    boundaries: { scope: 'single-normal-Smoke-session', modelCalls: 0, authorizationChanges: 0,
      providerRefreshRequested: false, repositoryCreated: false, cloudCreated: false } }
  async function request(path, { body, authenticated = true } = {}) {
    let response
    if (body === undefined) { report.getRequests++; assert(report.getRequests <= 10, 'request') }
    try {
      response = await fetchImpl(ORIGIN + '/mikka' + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { origin: ORIGIN, 'cache-control': 'no-store', ...(authenticated && cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch { fail('request') }
    if (authenticated) for (const header of response.headers.getSetCookie()) {
      remember(header)
      const first = header.split(';', 1)[0], separator = first.indexOf('=')
      if (separator < 1) continue
      const name = first.slice(0, separator), value = first.slice(separator + 1)
      remember(value)
      if (!value || /;\s*max-age=0(?:;|$)/i.test(header)) cookies.delete(name)
      else cookies.set(name, value)
    }
    return response
  }
  async function version() {
    const response = await request('/api/version', { authenticated: false })
    assert(response.status === 200, 'version')
    const value = await json(response)
    assert(typeof value?.build === 'string' && /^(?:dpl_[A-Za-z0-9]+|[a-f0-9]{40})$/.test(value.build), 'version')
    return value.build
  }
  let initialVersionMatched = false
  try {
    report.versionBefore = await version(); assert(report.versionBefore === TARGET.deployment, 'deployment'); initialVersionMatched = true
    const login = await request('/api/auth/sign-in/email', { body: { email, password } })
    report.authentication.loginStatus = login.status; await login.body?.cancel()
    assert(login.status === 200, 'signin'); assert(cookies.size > 0, 'cookie')
    const session = await request('/api/auth/get-session'); assert(session.status === 200, 'session')
    const identity = await json(session); remember(identity?.session?.token)
    assert(identity?.user?.email?.toLowerCase() === email.toLowerCase() && typeof identity.user.id === 'string' && identity.user.id
      && identity.session?.userId === identity.user.id, 'session')
    report.authentication.sessionVerified = true
    for (const [name, path, project] of [
      ['github', '/api/integrations/github', value => projectGitHub(value, identity.user.id)],
      ['permissions', '/api/integrations/github/permissions', value => projectPermissions(value, identity.user.id)],
      ['devices', '/api/mobile/threads', projectDevices],
    ]) {
      const response = await request(path)
      if (response.status !== 200) { report[name] = { httpStatus: response.status, observed: false }; report.errors.push('capability_' + name); await response.body?.cancel(); continue }
      report[name] = { httpStatus: response.status, observed: true, ...project(await json(response)) }
    }
  } catch (error) { report.errors.push(errorCode(error)) }
  finally {
    if (cookies.size) {
      try {
        const response = await request('/api/auth/sign-out', { body: {} }); report.authentication.signOutStatus = response.status
        assert(response.status === 200 && (await json(response))?.success === true, 'logout')
        report.authentication.sessionEnded = true
      } catch (error) { report.errors.push(errorCode(error)) }
      cookies.clear()
    }
    if (initialVersionMatched) {
      try { report.versionAfter = await version(); assert(report.versionAfter === TARGET.deployment, 'deployment') }
      catch (error) { report.errors.push(errorCode(error)) }
    }
  }
  report.completedAt = now()
  report.status = report.errors.length === 0 && report.authentication.sessionEnded && report.github?.observed && report.permissions?.observed && report.devices?.observed ? 'passed' : 'failed'
  const text = JSON.stringify(report)
  assert(![...secrets].some(secret => secret.length >= 8 && text.includes(secret)), 'projection')
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try { report = await runRuntimeCapabilities() }
  catch (error) { report = { schemaVersion: 1, status: 'failed', sourceRevision: TARGET.revision, expectedDeployment: TARGET.deployment, errors: [errorCode(error)] } }
  mkdirSync(resolve('runtime-capabilities-sanitized'), { recursive: true, mode: 0o700 })
  writeFileSync(resolve('runtime-capabilities-sanitized/results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, sourceRevision: TARGET.revision, deployment: TARGET.deployment,
    getRequests: report.getRequests ?? 0, sessionEnded: report.authentication?.sessionEnded ?? false, errors: report.errors }))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Read-only runtime capabilities\n\nStatus: ${report.status}. Model calls: 0. Session ended: ${report.authentication?.sessionEnded ?? false}.\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
