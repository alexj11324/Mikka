import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const origin = 'http://localhost:3000'
const second = 'http://app-replica:3000'
const mailpit = 'http://mailpit:8025'
const storage = 'http://minio:9000'
const bucket = 'mikka-selfhost-ci'
const sender = 'login@selfhost.example.test'
const check = (condition, code) => { if (!condition) throw new Error(`SELF_HOSTED_${code}`) }
const hash = value => createHash('sha256').update(value).digest('hex')

/** Reach either replica as the reverse proxy would: a different TCP endpoint
 * with the same configured Host. Node's fetch replaces a supplied Host with
 * the URL authority, so it cannot represent this two-replica request. */
export function fixtureHttp(url, { method = 'GET', headers = {}, body, signal } = {}) {
  check(new URL(url).protocol === 'http:', 'HTTP_FIXTURE_PROTOCOL')
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, signal }, response => {
      const responseHeaders = new Headers()
      for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1])
      const status = response.statusCode ?? 500
      resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response), { status, headers: responseHeaders }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

/** This driver deliberately has no arbitrary target URL option. It can mutate
 * only the disposable Compose network and its test database. */
export function assertFixtureEnvironment(env) {
  check(env.MIKKA_SELF_HOSTED_ACCEPTANCE === '1', 'FIXTURE_REQUIRED')
  check(env.BETTER_AUTH_URL === origin && (env.MIKKA_EDITION || 'community') === 'community', 'ORIGIN_OR_EDITION')
  check(/^[a-f0-9]{40}$/.test(env.MIKKA_EXPECTED_REVISION ?? ''), 'REVISION_REQUIRED')
  const database = new URL(env.MIKKA_DATABASE_URL ?? 'invalid:')
  check(database.protocol === 'postgres:' && database.hostname === 'postgres' && database.port === '5432'
    && database.pathname === '/mikka' && database.username === 'mikka' && Boolean(database.password)
    && !database.search && env.DATABASE_URL === env.MIKKA_DATABASE_URL, 'DATABASE_TARGET')
  check(env.SMTP_URL === 'smtp://mailpit:1025' && env.S3_ENDPOINT === storage && env.S3_BUCKET === bucket
    && env.S3_ACCESS_KEY_ID === 'selfhost-ci' && env.S3_REGION === 'us-east-1', 'SERVICES_TARGET')
  check(/^[A-Za-z0-9+/]{43}=$/.test(env.S3_SECRET_ACCESS_KEY ?? ''), 'FIXTURE_KEY_REQUIRED')
  check(env.MIKKA_DEFAULT_MODEL_BASE_URL === 'http://model:8080/v1'
    && env.MIKKA_DEFAULT_MODEL_API_KEY === 'synthetic-selfhost-only' && env.MIKKA_DEFAULT_MODEL_ID === 'selfhost-ci', 'MODEL_TARGET')
  for (const name of ['VERCEL', 'VERCEL_ENV', 'DEVICE_GATEWAY_URL', 'CLOUDFLARE_ACCOUNT_ID', 'RESEND_API_KEY', 'AI_GATEWAY_API_KEY', 'GITHUB_APP_PRIVATE_KEY', 'MIKKA_CLOUD_URL']) {
    check(!env[name], 'EXTERNAL_CREDENTIALS_REFUSED')
  }
}

/** Event queues retain a notification arriving before its HTTP request returns.
 * Waiting is event-driven and has a deadline; there is no refresh/poll loop. */
export function socketEvents(url, protocol) {
  const socket = new WebSocket(url, protocol)
  const queue = [], listeners = new Set()
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SELF_HOSTED_SOCKET_OPEN_TIMEOUT')), 15_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('SELF_HOSTED_SOCKET_OPEN_FAILED')) }, { once: true })
  })
  socket.addEventListener('message', event => {
    let value
    try { value = JSON.parse(String(event.data)) } catch { return }
    const listener = [...listeners].find(item => item.matches(value))
    if (listener) listener.done(value)
    else queue.push(value)
  })
  return {
    ready,
    next(matches, timeout = 30_000) {
      const found = queue.findIndex(matches)
      if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('SELF_HOSTED_EVENT_TIMEOUT')) }, timeout)
        const listener = { matches, done(value) { clearTimeout(timer); listeners.delete(listener); resolve(value) }, cancel() { clearTimeout(timer); reject(new Error('SELF_HOSTED_SOCKET_CLOSED')) } }
        listeners.add(listener)
      })
    },
    close() { for (const listener of listeners) listener.cancel(); listeners.clear(); socket.close() },
  }
}

/** Provision only this fixture bucket with AWS Signature V4. Actual object PUT
 * and presigned GET are performed by the application's production S3 adapter. */
export async function createFixtureBucket(env) {
  const time = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = time.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`, digest = hash('')
  const headers = { host: 'minio:9000', 'x-amz-content-sha256': digest, 'x-amz-date': time }
  const names = Object.keys(headers).sort()
  const canonical = ['PUT', `/${bucket}`, '', names.map(name => `${name}:${headers[name]}\n`).join(''), names.join(';'), digest].join('\n')
  let key = Buffer.from(`AWS4${env.S3_SECRET_ACCESS_KEY}`)
  for (const item of [day, 'us-east-1', 's3', 'aws4_request']) key = createHmac('sha256', key).update(item).digest()
  const signature = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n${time}\n${scope}\n${hash(canonical)}`).digest('hex')
  const response = await fetch(`${storage}/${bucket}`, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` } })
  check(response.status === 200, 'BUCKET_CREATE')
  await response.body?.cancel()
}

/** Diagnose a failed read without retaining any chat text, identity, provider
 * message or arbitrary error value. This projection never changes admission. */
export function chatObservation(chat, expectedReply) {
  const items = Array.isArray(chat?.items) ? chat.items : []
  const last = items.at(-1)
  const kinds = ['person', 'coordinator', 'event']
  const failures = ['hosted', 'subscription', 'wake', 'failed']
  const codes = ['wake_failed', 'wake_start_unconfirmed', 'wake_exhausted', 'verification_required', 'free_allowance_used', 'points_exhausted', 'model_tool_unavailable']
  return {
    enabled: typeof chat?.enabled === 'boolean' ? chat.enabled : null,
    working: typeof chat?.working === 'boolean' ? chat.working : null,
    error: !chat?.error ? 'none' : codes.includes(chat.error) ? chat.error : 'unclassified',
    failure: !chat?.failure ? 'none' : failures.includes(chat.failure.kind) ? chat.failure.kind : 'unclassified',
    failureCode: codes.includes(chat?.failure?.code) ? chat.failure.code : chat?.failure?.code ? 'unclassified' : 'none',
    itemCount: items.length,
    lastFrom: kinds.includes(last?.from) ? last.from : last ? 'unclassified' : 'none',
    lastPending: last?.pending === true,
    streamPresent: typeof chat?.streamRunId === 'string' && chat.streamRunId.length > 0,
    expectedReplyPresent: items.some(item => item?.from === 'coordinator' && typeof item.text === 'string' && item.text.includes(expectedReply)),
  }
}

export async function runAcceptance(env = process.env) {
  assertFixtureEnvironment(env)
  const report = { kind: 'isolated-self-hosted-services', revision: env.MIKKA_EXPECTED_REVISION, origin,
    provider: 'synthetic-openai-compatible', productionAcceptance: false, checks: {}, status: 'running', stage: 'startup' }
  const cookies = new Map(), sockets = []
  const request = async (path, { target = origin, method = 'GET', body, binary = false, expected = [200] } = {}) => {
    check([origin, second].includes(target) && path.startsWith('/mikka/'), 'REQUEST_TARGET')
    const response = await fixtureHttp(`${target}${path}`, { method, signal: AbortSignal.timeout(30_000),
      headers: { host: 'localhost:3000', origin, ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(body !== undefined ? { 'content-type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}) })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0], index = pair.indexOf('=')
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    check(expected.includes(response.status), `HTTP_STATUS_${response.status}`)
    return response
  }
  try {
    const version = await (await request('/mikka/api/version')).json()
    check(version.build === env.MIKKA_EXPECTED_REVISION, 'REVISION_MISMATCH')
    report.stage = 'replica-version'
    check((await (await request('/mikka/api/version', { target: second })).json()).build === version.build, 'REPLICA_REVISION_MISMATCH')
    report.stage = 'minio-bucket'
    await createFixtureBucket(env)

    report.stage = 'smtp-and-auth'
    const mailbox = socketEvents(`${mailpit.replace('http:', 'ws:')}/api/events`)
    sockets.push(mailbox); await mailbox.ready
    const email = `selfhost-${randomUUID()}@selfhost.example.test`
    const password = randomBytes(24).toString('base64url'), replacement = randomBytes(24).toString('base64url')
    const nextMail = async subject => {
      const event = await mailbox.next(value => value.Type === 'new' && value.Data?.Subject === subject && value.Data?.To?.some(to => to.Address === email))
      check(event.Data.From?.Address === sender, 'MAIL_SENDER')
      const response = await fetch(`${mailpit}/api/v1/message/${encodeURIComponent(event.Data.ID)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
      check(response.ok, 'MAIL_READ')
      const message = await response.json()
      check(message.From?.Address === sender && message.To?.some(to => to.Address === email), 'MAIL_RECIPIENT')
      const links = String(message.Text).match(/http:\/\/localhost:3000\/mikka\/[^\s]+/g)
      check(links?.length === 1, 'MAIL_LINK')
      return new URL(links[0])
    }
    await request('/mikka/api/auth/sign-up/email', { method: 'POST', expected: [200, 201], body: { name: 'Self-hosted acceptance', email, password } })
    const verification = await nextMail('Verify your Mikka email address')
    check(verification.origin === origin && verification.pathname === '/mikka/api/auth/verify-email', 'VERIFICATION_LINK')
    const verified = await request(`${verification.pathname}${verification.search}`, { expected: [302] })
    check(verified.headers.get('location') === `${origin}/mikka/sign-in`, 'VERIFICATION_RETURN')
    await request('/mikka/api/auth/request-password-reset', { method: 'POST', expected: [202], body: { email, redirectTo: `${origin}/mikka/reset-password` } })
    const reset = await nextMail('Reset your Mikka password')
    check(reset.origin === origin && reset.pathname.startsWith('/mikka/api/auth/reset-password/'), 'RESET_LINK')
    const returned = await request(`${reset.pathname}${reset.search}`, { expected: [302] })
    const resetForm = new URL(returned.headers.get('location') ?? 'invalid:')
    check(resetForm.origin === origin && resetForm.pathname === '/mikka/reset-password' && Boolean(resetForm.searchParams.get('token')), 'RESET_RETURN')
    await request('/mikka/api/auth/reset-password', { method: 'POST', body: { token: resetForm.searchParams.get('token'), newPassword: replacement } })
    cookies.clear()
    await request('/mikka/api/auth/sign-in/email', { method: 'POST', body: { email, password: replacement } })
    const session = await (await request('/mikka/api/auth/get-session')).json()
    check(session.user?.emailVerified === true && session.user?.email === email, 'VERIFIED_SIGN_IN')
    report.checks.mailpit = { verificationReceived: true, passwordResetReceived: true, configuredSender: true, verifiedSignIn: true }

    report.stage = 'cross-replica-live'
    const workspace = await (await request('/mikka/api/workspace')).json()
    check(typeof workspace.workspace?.id === 'string', 'WORKSPACE_CREATED')
    const ticket = await (await request(`/mikka/api/live/ticket?workspace=${workspace.workspace.id}`)).json()
    const liveURL = new URL(ticket.url)
    check(liveURL.origin === origin.replace('http:', 'ws:') && liveURL.pathname.startsWith('/mikka/v1/live/'), 'BUILTIN_TICKET')
    liveURL.searchParams.set('revisions', '1')
    const live = socketEvents(liveURL.href, ticket.protocol)
    sockets.push(live); await live.ready
    await live.next(value => value.type === 'live_ready' && value.version === 2)
    const bot = await (await request('/mikka/api/bots', { target: second, method: 'POST', expected: [201], body: { name: 'Self-hosted acceptance bot' } })).json()
    check(typeof bot.id === 'string' && bot.workspaceId === workspace.workspace.id, 'BOT_CREATED')
    await live.next(value => value.kind === 'bot_list' && value.id === workspace.workspace.id)
    report.checks.live = { applications: 2, sharedPostgres: true, cloudflare: false, businessMutationReceivedAcrossReplicas: true }

    report.stage = 'minio-upload-download'
    const bytes = Buffer.from('Self-hosted S3 interoperability fixture.\nUTF-8: 中文。\n')
    const upload = await (await request('/mikka/api/chat/attachments', { method: 'POST', body: {
      operation: 'init', scope: { kind: 'bot', id: bot.id }, name: 'selfhost.txt', size: bytes.length, mediaType: 'text/plain',
    } })).json()
    check(typeof upload.id === 'string', 'UPLOAD_CREATED')
    await request(`/mikka/api/chat/attachments?id=${upload.id}`, { target: second, method: 'POST', binary: true, body: bytes })
    const file = await (await request(`/mikka/api/chat/attachments/${upload.id}?download-url`)).json()
    const signed = new URL(file.downloadUrl)
    check(signed.origin === storage && signed.pathname.startsWith(`/${bucket}/chat-files/`) && signed.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256', 'S3_PRESIGNED_DOWNLOAD')
    const downloaded = await fetch(signed, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    check(downloaded.ok && Buffer.from(await downloaded.arrayBuffer()).equals(bytes), 'S3_BYTES')
    const anonymous = await fetch(`${signed.origin}${signed.pathname}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    check(anonymous.status === 403, 'S3_PRIVATE_OBJECT'); await anonymous.body?.cancel()
    report.checks.minio = { applicationUpload: true, privateObject: true, presignedDownload: true, bytesVerified: true }

    report.stage = 'community-chat-31'
    report.chatProgress = { confirmedReplies: 0 }
    for (let turn = 1; turn <= 31; turn++) {
      const number = String(turn).padStart(2, '0'), reply = `SELF_HOSTED_REPLY_${number}`
      await request('/mikka/api/mobile/chat', { method: 'POST', expected: [202], body: { botId: bot.id, text: `selfhost_turn_${number}`, submissionId: randomUUID() } })
      const deadline = Date.now() + 45_000
      for (;;) {
        const chat = await (await request(`/mikka/api/mobile/chat?bot=${bot.id}`)).json()
        if (!(chat.enabled === true && !chat.error && !chat.failure)) {
          report.chatObservation = { turn, ...chatObservation(chat, reply) }
        }
        check(chat.enabled === true && !chat.error && !chat.failure, 'CHAT_UNAVAILABLE')
        if (!chat.working && chat.items?.some(item => item.from === 'coordinator' && item.text?.includes(reply))) {
          report.chatProgress.confirmedReplies = turn
          break
        }
        check(Date.now() < deadline, 'CHAT_REPLY_TIMEOUT')
        await live.next(value => value.kind === 'bot_chat' && value.id === bot.id, deadline - Date.now())
      }
    }
    const provider = await (await fetch('http://model:8080/evidence', { redirect: 'error', signal: AbortSignal.timeout(10_000) })).json()
    check(provider.synthetic === true && provider.turns?.length === 31 && provider.calls >= 31, 'MODEL_EVIDENCE')
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: env.MIKKA_DATABASE_URL, max: 1 })
    try {
      const ledger = await pool.query('SELECT count(*)::integer AS n FROM hosted_usage WHERE "workspaceId"=$1', [workspace.workspace.id])
      check(ledger.rows[0].n === 0, 'COMMUNITY_METERING')
    } finally { await pool.end() }
    report.checks.chat = { messages: 31, replies: 31, provider: 'synthetic-openai-compatible', hostedUsageRows: 0, subscriptionAcceptance: false }
    await request(`/mikka/api/chat/attachments/${upload.id}`, { method: 'DELETE' })
    // Private one-run handoff to the same-revision source daemon on the CI
    // runner. Never include this file in reports or retained artifacts.
    await writeFile('/data/self-hosted-daemon-session.private.json', JSON.stringify({ revision: version.build, origin,
      ownerId: session.user.id, workspaceId: workspace.workspace.id,
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }), { flag: 'wx', mode: 0o600 })
    report.status = 'passed'; report.stage = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.code = /^SELF_HOSTED_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'SELF_HOSTED_UNEXPECTED_FAILURE'
    report.errorName = /^[A-Za-z]{1,64}$/.test(error?.name ?? '') ? error.name : 'Error'
  } finally { for (const socket of sockets) socket.close() }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try { report = await runAcceptance() }
  catch { report = { kind: 'isolated-self-hosted-services', status: 'failed', stage: 'guard', code: 'SELF_HOSTED_FIXTURE_REFUSED' } }
  // No cookie, email address, mail contents, signed URL, secret, or provider input
  // reaches the retained report or the Actions log.
  await writeFile('/data/self-hosted-services-evidence.json', `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  if (report.status !== 'passed') process.exitCode = 1
}
