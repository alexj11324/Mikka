import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Pool } from 'pg'
import { assertDeploymentIdentity, environmentFingerprint, loadEnvironment, validateEnvironment } from './environment.mjs'
import { createEvidenceScanBudget, forbiddenRecordingPath, scanEvidenceContent } from './evidence-content.mjs'
import { TestAccountPool, TestAccountError } from './pool.mjs'
import { readBoundedBody } from './http-body.mjs'

const fail = code => { throw new TestAccountError(code) }
const safeError = error => error instanceof TestAccountError ? error : new TestAccountError('TEST_ACCOUNT_SESSION_FAILED')

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('PRIVATE_DIRECTORY_UNSAFE')
}

async function writePrivate(path, value, { append = false } = {}) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : constants.O_EXCL)
  const handle = await open(path, flags, 0o600)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('PRIVATE_FILE_UNSAFE')
    await handle.writeFile(`${JSON.stringify(value)}\n`)
  } finally { await handle.close() }
}

async function readPrivate(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) fail('PRIVATE_FILE_UNSAFE')
    return JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
}

function scopedURL(environment, path) {
  let url
  try {
    if (typeof path !== 'string' || path.includes('\\')) fail('TEST_ACCOUNT_FOREIGN_ORIGIN')
    const relative = path === '/' ? environment.basePath : path.startsWith('/api/') ? `${environment.basePath}${path}` : path
    url = new URL(relative, environment.origin)
  } catch { fail('TEST_ACCOUNT_FOREIGN_ORIGIN') }
  if (url.origin !== environment.origin || url.username || url.password || url.hash || !(url.pathname === environment.basePath || url.pathname.startsWith(`${environment.basePath}/`))) fail('TEST_ACCOUNT_FOREIGN_ORIGIN')
  return url
}

/** A real HTTP-authenticated scope. Credentials never appear in its public shape. */
export async function acquireTestAccounts({ database, environment, runId, workerId, requestId, ttlMs = 90_000, stateDirectory } = {}) {
  environment ??= await loadEnvironment()
  // Verify the built application and actual database before even taking a slot.
  await assertDeploymentIdentity(environment)
  const ownDatabase = !database
  database ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
  const pool = new TestAccountPool(database, environment)
  let lease
  let acquireStarted
  try {
    await pool.prepare({ pairs: 2 })
    acquireStarted = performance.now()
    lease = await pool.acquire({ runId, workerId, requestId, ttlMs })
    if (lease.state !== 'active') fail('LEASE_ALREADY_COMPLETED')
    // Metadata acquisition is retryable, but attaching a second session runner
    // must never log in again or clean up the first runner on its own failure.
    await pool.attachSession(lease, randomUUID())
  } catch (error) { if (ownDatabase) await database.end(); throw safeError(error) }

  const binding = environmentFingerprint(environment)
  const directory = resolve(stateDirectory ?? join('.cache/e2e/test-accounts', environment.instanceId))
  const credentialsDirectory = join(directory, 'credentials')
  const statesDirectory = join(directory, 'sessions')
  const auditFile = join(directory, 'secret-audit.jsonl')
  const stateFiles = []
  const listeners = new Set()
  const pendingRequests = new Set()
  const abort = new AbortController()
  let closed = false
  let closing = false
  let lost = false
  let tainted = false
  let releasing
  let renewal
  // A monotonic client budget complements authoritative PG time. It is anchored
  // BEFORE every renew RPC, so network latency never grants extra authority.
  let deadline = acquireStarted + Math.min(ttlMs, lease.remainingMs)
  function lose() {
    if (lost || closed) return
    lost = true
    abort.abort()
    for (const listener of listeners) { try { listener() } catch { /* no secret-bearing callback errors */ } }
  }
  async function assertActive() {
    if (closed || closing) fail('LEASE_CLOSED')
    if (lost || performance.now() >= deadline) { lose(); fail('LEASE_LOST') }
    try { await pool.assertLease(lease) } catch { lose(); fail('LEASE_LOST') }
    if (closed || closing) fail('LEASE_CLOSED')
    if (lost || performance.now() >= deadline) { lose(); fail('LEASE_LOST') }
  }
  async function renew() {
    if (closed || closing) fail('LEASE_CLOSED')
    if (lost || performance.now() >= deadline) { lose(); fail('LEASE_LOST') }
    if (renewal) return renewal
    const started = performance.now()
    renewal = pool.renew(lease, { ttlMs }).then(result => {
      if (closed || lost || performance.now() >= started + ttlMs) { lose(); fail('LEASE_LOST') }
      lease = result
      deadline = started + Math.min(ttlMs, result.remainingMs)
      return result
    }).catch(() => { lose(); fail('LEASE_LOST') }).finally(() => { renewal = undefined })
    return renewal
  }
  const timer = setInterval(() => { void renew().catch(() => {}) }, Math.max(250, Math.floor(ttlMs / 3)))
  timer.unref()

  async function release({ outcome = 'clean' } = {}) {
    if (releasing) return releasing
    closing = true
    clearInterval(timer)
    const pending = [...pendingRequests]
    abort.abort()
    releasing = (async () => {
      await Promise.allSettled(pending)
      if (renewal) await renewal.catch(() => {})
      try {
        if (lost || performance.now() >= deadline) { lose(); fail('LEASE_LOST') }
        // Revoke tracked bearer credentials without removing rows or evidence.
        // Pending requests remain dirty: revocation cannot cancel authenticated work.
        await pool.revokeSessions(lease)
        let statesValid = true
        for (const path of stateFiles) {
          try {
            const state = await readPrivate(path)
            if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) statesValid = false
          } catch { statesValid = false }
        }
        const releaseOutcome = (pending.length || tainted || !statesValid) && outcome === 'clean' ? 'dirty' : outcome
        const result = await pool.release(lease, { outcome: releaseOutcome })
        if (!statesValid) fail('SESSION_STATE_RETENTION_FAILED')
        if (outcome === 'clean' && result.state !== 'released') fail('ACCOUNT_DIRTY')
        return result
      } finally {
        closed = true
        abort.abort()
        if (ownDatabase) await database.end()
      }
    })()
    return releasing
  }

  const scope = {
    pool, get lease() { return lease }, owner: undefined, peer: undefined,
    assertActive, renew, release,
    onLeaseLost(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    recordResource(resource) { return pool.recordResource(lease, resource) },
    markResourceCleaned(resource) { return pool.markResourceCleaned(lease, resource) },
  }

  try {
    await privateDirectory(directory)
    await privateDirectory(credentialsDirectory)
    await privateDirectory(statesDirectory)

    for (const slot of lease.accounts) {
      await assertActive()
      const provision = !slot.userId
      if (provision && !environment.capabilities.provision) fail('ACCOUNT_PROVISIONING_NOT_AUTHORIZED')
      let credential
      let ref = slot.credentialRef
      if (provision) {
        ref = `${randomUUID()}.json`
        credential = { binding, slotId: slot.slotId, email: `test-${randomUUID()}@example.test`, password: randomBytes(32).toString('base64url') }
        await writePrivate(join(credentialsDirectory, ref), credential)
        // Reserve the intended identity before network I/O. A timeout cannot
        // orphan an untracked user or trigger a second blind registration.
        await pool.reserveAccount(lease, { slotId: slot.slotId, email: credential.email, credentialRef: ref })
      } else {
        if (!/^[a-f0-9-]{36}\.json$/.test(ref ?? '')) fail('CREDENTIAL_REFERENCE_INVALID')
        credential = await readPrivate(join(credentialsDirectory, ref))
        if (credential.binding !== binding || credential.slotId !== slot.slotId || credential.email !== slot.email || typeof credential.password !== 'string' || credential.password.length < 32) fail('CREDENTIAL_ENVIRONMENT_MISMATCH')
      }
      const cookies = new Map()
      const clientIP = `198.18.${randomBytes(1)[0]}.${1 + randomBytes(1)[0] % 254}`
      async function request(path, init = {}) {
        const url = scopedURL(environment, path)
        let settled
        const pending = new Promise(resolve => { settled = resolve })
        pendingRequests.add(pending)
        try {
          await assertActive()
          const headers = new Headers(init.headers)
          if (headers.has('cookie') || headers.has('authorization') || headers.has('host')) fail('TEST_ACCOUNT_CREDENTIAL_OVERRIDE_FORBIDDEN')
          headers.set('origin', environment.origin)
          headers.set('x-forwarded-for', clientIP)
          if (cookies.size) headers.set('cookie', [...cookies.values()].filter(cookie => cookie.expires === -1 || cookie.expires > Date.now() / 1000).map(cookie => `${cookie.name}=${cookie.value}`).join('; '))
          let response
          try {
            const signals = [abort.signal, AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]
            response = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.any(signals) })
          } catch { tainted = true; if (lost) fail('LEASE_LOST'); fail('TEST_ACCOUNT_HTTP_FAILED') }
          await assertActive()
          if (response.status >= 500) tainted = true
          // These acceptance clients are bounded request/response clients, not
          // streaming Agent clients. Drain the response before releasing its
          // in-flight guard: headers alone do not prove the handler finished.
          let bytes
          try {
            bytes = await readBoundedBody(response, 8 * 1024 * 1024)
          } catch (error) {
            tainted = true
            fail(error.message === 'RESPONSE_BODY_TOO_LARGE' ? 'TEST_ACCOUNT_RESPONSE_TOO_LARGE' : 'TEST_ACCOUNT_RESPONSE_INCOMPLETE')
          }
          for (const header of response.headers.getSetCookie()) {
            const parts = header.split(';').map(item => item.trim())
            const separator = parts[0].indexOf('=')
            if (separator < 1) fail('TEST_ACCOUNT_COOKIE_INVALID')
            const name = parts[0].slice(0, separator)
            const value = parts[0].slice(separator + 1)
            const attributes = Object.fromEntries(parts.slice(1).map(part => { const at = part.indexOf('='); return at < 0 ? [part.toLowerCase(), true] : [part.slice(0, at).toLowerCase(), part.slice(at + 1)] }))
            const host = new URL(environment.origin).hostname
            if (attributes.domain && String(attributes.domain).replace(/^\./, '') !== host) fail('TEST_ACCOUNT_COOKIE_ORIGIN_MISMATCH')
            const cookie = { name, value, domain: host, path: attributes.path || '/',
              expires: attributes['max-age'] !== undefined ? Date.now() / 1000 + Number(attributes['max-age']) : attributes.expires ? new Date(attributes.expires).getTime() / 1000 : -1,
              httpOnly: Boolean(attributes.httponly), secure: Boolean(attributes.secure),
              sameSite: String(attributes.samesite).toLowerCase() === 'strict' ? 'Strict' : String(attributes.samesite).toLowerCase() === 'none' ? 'None' : 'Lax',
            }
            if (!value || (cookie.expires !== -1 && cookie.expires <= Date.now() / 1000)) cookies.delete(name)
            else {
              cookies.set(name, cookie)
              await writePrivate(auditFile, { values: [...(name.includes('_multi-') ? [name] : []), value, decodeURIComponent(value)] }, { append: true })
            }
          }
          if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
            // Never follow a redirect while carrying a session, even same-host ports.
            scopedURL(environment, new URL(response.headers.get('location'), url).href)
          }
          await assertActive()
          return new Response([204, 205, 304].includes(response.status) || init.method === 'HEAD' ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
        } finally { pendingRequests.delete(pending); settled() }
      }
      const login = await request(provision ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: credential.email, password: credential.password, ...(provision ? { name: `Test ${slot.role}` } : {}) }),
      })
      if (!login.ok) { await login.body?.cancel(); fail(provision ? 'ACCOUNT_PROVISIONING_FAILED' : 'ACCOUNT_LOGIN_FAILED') }
      const result = await login.json()
      const userId = result?.user?.id
      if (typeof userId !== 'string' || result.user.email !== credential.email || (!provision && userId !== slot.userId)) fail('ACCOUNT_IDENTITY_MISMATCH')
      if (provision) lease = await pool.bindAccount(lease, { slotId: slot.slotId, userId, email: credential.email, credentialRef: ref })
      const check = await request('/api/auth/get-session')
      if (!check.ok) fail('ACCOUNT_SESSION_INVALID')
      const session = await check.json()
      if (session?.user?.id !== userId || session?.user?.email !== credential.email || !session.session?.id) fail('ACCOUNT_SESSION_INVALID')
      if (typeof session.session.token === 'string' && session.session.token.length >= 12) {
        await writePrivate(auditFile, { values: [session.session.token] }, { append: true })
      }
      await pool.recordResource(lease, { type: 'session', id: session.session.id, ownerId: userId })
      const initialized = await request('/api/workspace')
      if (!initialized.ok) { await initialized.body?.cancel(); fail('ACCOUNT_INITIALIZATION_FAILED') }
      await initialized.body?.cancel()
      const landing = await request(environment.basePath)
      if (!landing.ok) { await landing.body?.cancel(); fail('ACCOUNT_INITIALIZATION_FAILED') }
      await landing.body?.cancel()
      if (provision) await pool.sealAccount(lease, slot.slotId)
      const storageStatePath = join(statesDirectory, `${lease.id}-${lease.generation}-${slot.role}.json`)
      await writePrivate(storageStatePath, { cookies: [...cookies.values()], origins: [] })
      stateFiles.push(storageStatePath)
      scope[slot.role] = { userId, slotId: slot.slotId, namespace: slot.namespace, role: slot.role, storageStatePath, request }
    }
    return scope
  } catch (error) {
    await release({ outcome: 'dirty' }).catch(() => {})
    throw safeError(error)
  }
}

export async function withTestAccounts(options, callback) {
  const scope = await acquireTestAccounts(options)
  let complete = false
  try { const result = await callback(scope); complete = true; return result }
  finally { await scope.release({ outcome: complete ? 'clean' : 'dirty' }) }
}

/** Retain authentication material only in the private per-environment scanner store. */
export async function recordAuthenticationSecrets(values, { environment } = {}) {
  environment ??= await loadEnvironment()
  validateEnvironment(environment)
  if (!Array.isArray(values) || values.length > 1000 || values.some(value => typeof value !== 'string' || value.length > 65536)) fail('SECRET_AUDIT_INVALID')
  const directory = resolve('.cache/e2e/test-accounts', environment.instanceId)
  await privateDirectory(directory)
  await writePrivate(join(directory, 'secret-audit.jsonl'), { values: values.filter(value => value.length) }, { append: true })
}

/** Scan raw and bounded embedded report content; never print a matched secret. */
export async function auditEvidence(paths, { environment, stateDirectory } = {}) {
  environment ??= await loadEnvironment()
  const directory = resolve(stateDirectory ?? join('.cache/e2e/test-accounts', environment.instanceId))
  const secrets = new Set()
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) || (process.getuid && root.uid !== process.getuid())) fail('PRIVATE_DIRECTORY_UNSAFE')
  let credentialNames = []
  try {
    const credentials = await lstat(join(directory, 'credentials'))
    if (!credentials.isDirectory() || credentials.isSymbolicLink() || (credentials.mode & 0o077) || (process.getuid && credentials.uid !== process.getuid())) fail('PRIVATE_DIRECTORY_UNSAFE')
    credentialNames = await readdir(join(directory, 'credentials'))
  } catch (error) { if (error.code !== 'ENOENT') fail('SECRET_AUDIT_UNREADABLE') }
  for (const name of credentialNames) {
    const credential = await readPrivate(join(directory, 'credentials', name))
    if (credential.password) secrets.add(credential.password)
  }
  let records = ''
  let audit
  try {
    audit = await open(join(directory, 'secret-audit.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await audit.stat()
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16 * 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) fail('PRIVATE_FILE_UNSAFE')
    records = await audit.readFile('utf8')
  } catch (error) { if (error.code !== 'ENOENT') fail('SECRET_AUDIT_UNREADABLE') }
  finally { await audit?.close() }
  try {
    for (const line of records.split('\n').filter(Boolean)) {
      const { values } = JSON.parse(line)
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) fail('SECRET_AUDIT_INVALID')
      for (const value of values) if (value.length >= 12) secrets.add(value)
    }
  } catch { fail('SECRET_AUDIT_INVALID') }
  if (process.env.BETTER_AUTH_SECRET) secrets.add(process.env.BETTER_AUTH_SECRET)
  if (process.env.E2E_DATABASE_URL) secrets.add(decodeURIComponent(new URL(process.env.E2E_DATABASE_URL).password))
  if (!records && !credentialNames.length) fail('SECRET_AUDIT_MISSING')
  const variants = [...secrets].filter(Boolean).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]).map(value => Buffer.from(value))
  const budget = createEvidenceScanBudget()
  let files = 0
  async function scan(path) {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) fail('EVIDENCE_SYMLINK_FORBIDDEN')
    if (forbiddenRecordingPath(path)) fail('UNREVIEWED_SECRET_BEARING_EVIDENCE')
    if (stat.isDirectory()) { for (const name of await readdir(path)) await scan(join(path, name)); return }
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) fail('EVIDENCE_FILE_UNSAFE')
    const data = await readFile(path)
    files++
    scanEvidenceContent(data, variants, { budget })
  }
  for (const path of paths) await scan(resolve(path))
  return { files, archives: budget.archives, archiveEntries: budget.entries, decodedBytes: budget.decodedBytes, result: 'passed', checked: 'known credentials and cookies in raw files and decoded Playwright reports; traces and recordings forbidden' }
}
