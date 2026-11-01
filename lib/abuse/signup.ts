import { localTestMode } from '@mikka/protocol/local-test-mode'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { APIError } from 'better-auth'
import { auditRequestContext } from '../audit/events'
const domains = new Set(
  readFileSync(
    join(process.cwd(), 'lib/abuse/data/disposable-email-domains.txt'),
    'utf8',
  )
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#')),
)
export function normalizedEmail(email: string) {
  const [local, rawDomain] = email.trim().toLowerCase().split('@')
  const domain = rawDomain === 'googlemail.com' ? 'gmail.com' : rawDomain
  const name = local.split('+')[0]
  return `${domain === 'gmail.com' ? name.replaceAll('.', '') : name}@${domain}`
}
export function disposableEmail(email: string) {
  const domain = email.toLowerCase().split('@')[1] ?? ''
  const parts = domain.split('.')
  return parts.some((_, i) => domains.has(parts.slice(i).join('.')))
}
const failure = (
  status: 'BAD_REQUEST' | 'TOO_MANY_REQUESTS' | 'SERVICE_UNAVAILABLE',
  code: string,
): never => {
  throw new APIError(status, { code, message: code })
}
export async function verifyTurnstile(
  token: unknown,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  const secret = env.TURNSTILE_SECRET_KEY
  if (!secret) {
    if (env.VERCEL_ENV === 'production') {
      console.error('signup_turnstile_not_configured')
      failure('SERVICE_UNAVAILABLE', 'SIGNUP_VERIFICATION_UNAVAILABLE')
    }
    return
  }
  if (typeof token !== 'string' || !token || token.length > 2048)
    failure('BAD_REQUEST', 'TURNSTILE_REQUIRED')
  try {
    const response = await fetchImpl(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token as string }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    const result = (await response.json()) as {
      success?: boolean
      hostname?: string
    }
    if (!response.ok || result.success !== true)
      failure('BAD_REQUEST', 'TURNSTILE_INVALID')
    if (
      env.VERCEL_ENV === 'production' &&
      !(
        result.hostname === 'aspectlylabs.com' ||
        result.hostname?.endsWith('.aspectlylabs.com')
      )
    )
      failure('BAD_REQUEST', 'TURNSTILE_INVALID')
  } catch (error) {
    if (error instanceof APIError) throw error
    failure('SERVICE_UNAVAILABLE', 'SIGNUP_VERIFICATION_UNAVAILABLE')
  }
}
/** Reuse the existing trusted proxy/IP policy rather than client-chosen headers. */
export function signupClientIP(
  headers: Pick<Headers, 'get'>,
  env: Record<string, string | undefined> = process.env,
) {
  return auditRequestContext(headers, env).ip ?? 'local'
}
/**
 * Local test mode: a developer's own disposable database, where every signup
 * comes from one 'local' IP. Off in production and on Vercel; on only with
 * MIKKA_LOCAL_TEST_ACCOUNTS=1 and an app database that is a loopback *_e2e one
 * (packages/protocol/src/local-test-mode.ts).
 */
export function localTestSignups(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV !== 'production' && localTestMode(env)
}
export function signupLimits(
  env: Record<string, string | undefined> = process.env,
) {
  const positive = (value: string | undefined, fallback: number) => {
    const n = Number(value)
    return Number.isSafeInteger(n) && n > 0 ? n : fallback
  }
  // Locally, CI's limits (.github/workflows/browser-tests.yml) unless set explicitly.
  const local = localTestSignups(env)
  return {
    signupIp: positive(env.MIKKA_SIGNUP_IP_HOURLY, local ? 1000 : 5),
    signupGlobal: positive(env.MIKKA_SIGNUP_GLOBAL_HOURLY, local ? 10000 : 100),
    verificationIp: positive(env.MIKKA_VERIFICATION_IP_HOURLY, local ? 1000 : 15),
    verificationGlobal: positive(env.MIKKA_VERIFICATION_GLOBAL_HOURLY, local ? 10000 : 300),
  }
}
/** Atomic fixed-hour counters in Better Auth's rateLimit storage. */
export async function signupRateLimit(
  pool: Pool,
  kind: 'signup' | 'verification',
  ip: string,
  email: string,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
) {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    const window = Math.floor(now / 3_600_000)
    const hash = (value: string) =>
      createHash('sha256').update(value).digest('hex')
    const limits = signupLimits(env)
    // Same order on every request, so the global quota serializes admissions.
    for (const [scope, value, max] of [
      [
        'global',
        'all',
        kind === 'signup' ? limits.signupGlobal : limits.verificationGlobal,
      ],
      ['ip', ip, kind === 'signup' ? limits.signupIp : limits.verificationIp],
      ['email', normalizedEmail(email), 3],
    ] as const) {
      const key = `abuse:${kind}:${scope}:${hash(value)}:${window}`
      const {
        rows: [row],
      } = await tx.query(
        `INSERT INTO "rateLimit" (id,key,count,"lastRequest") VALUES ($1,$2,1,$3)
        ON CONFLICT (key) DO UPDATE SET count="rateLimit".count+1,"lastRequest"=$3 RETURNING count`,
        [randomUUID(), key, now],
      )
      if (row.count > max) failure('TOO_MANY_REQUESTS', 'SIGNUP_RATE_LIMITED')
    }
    await tx.query('COMMIT')
  } catch (error) {
    await tx.query('ROLLBACK')
    throw error
  } finally {
    tx.release()
  }
}
export async function beforeSignup(
  pool: Pool,
  ctx: { path?: string; body?: Record<string, unknown>; request?: Request },
) {
  if (!['/sign-up/email', '/send-verification-email'].includes(ctx.path ?? ''))
    return
  const email = ctx.body?.email
  if (typeof email !== 'string') return
  const headers = ctx.request?.headers
  const ip = signupClientIP(headers ?? new Headers())
  await verifyTurnstile(
    ctx.body?.turnstileToken ?? headers?.get('x-turnstile-token'),
  )
  await signupRateLimit(
    pool,
    ctx.path === '/sign-up/email' ? 'signup' : 'verification',
    ip,
    email,
  )
  if (ctx.path === '/sign-up/email') {
    if (disposableEmail(email)) failure('BAD_REQUEST', 'DISPOSABLE_EMAIL')
    if (
      (
        await pool.query(
          'SELECT 1 FROM signup_email_claims WHERE normalized=$1',
          [normalizedEmail(email)],
        )
      ).rowCount
    )
      failure('BAD_REQUEST', 'EMAIL_ALREADY_REGISTERED')
  }
}
