import { createHash, randomBytes } from 'node:crypto'
import { APIError, type BetterAuthOptions, type User, type DBAdapter } from 'better-auth'
import { runWithTransaction } from '@better-auth/core/context'
import { verifyJWT } from 'better-auth/crypto'

export const AUTH_EMAIL_TTL_SECONDS = 15 * 60
export const AUTH_EMAIL_FROM = 'Mikka <noreply@aspectlylabs.com>'

type VerificationStore = {
  reserveVerificationValue(input: { identifier: string; value: string; expiresAt: Date }): Promise<boolean>
  consumeVerificationValue(identifier: string): Promise<{ value: string } | null>
  findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>
  findUserById(id: string): Promise<User | null>
  updateUser(id: string, data: Partial<User> & Record<string, unknown>): Promise<User | null>
}
export type AuthMailContext = { secret: string; internalAdapter: VerificationStore }
type MailContext = AuthMailContext & { adapter: DBAdapter }
type HookContext = { path?: string; body?: Record<string, unknown>; query?: Record<string, unknown>; request?: Request; context: MailContext }
type MailKind = 'verification' | 'password-reset'
type MailData = { user: { id: string; email: string }; url: string; token: string }
type Delivery = { kind: MailKind; outcome: 'accepted_by_provider' | 'failed' | 'throttled' }

function digest(value: string) { return createHash('sha256').update(value).digest('hex') }
function invalidLink(stage = 'validation'): never {
  console.warn('auth_email_verification_rejected', { stage })
  throw new APIError('BAD_REQUEST', { code: 'INVALID_TOKEN', message: 'Invalid or expired link' }) }
function unavailable(): never { throw new APIError('SERVICE_UNAVAILABLE', { code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE', message: 'Email service unavailable' }) }

export function createAuthEmail(options: {
  origin: string
  apiKey: () => string | undefined
  context: () => Promise<AuthMailContext>
  fetch?: typeof fetch
  report?: (event: Delivery) => void
  background?: (task: () => Promise<void>) => void
}) {
  const origin = new URL(options.origin).origin
  if (origin !== options.origin || (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) throw new Error('Invalid authentication email origin')
  const base = `${origin}/mikka/api/auth`
  const verifyReturn = `${origin}/mikka/sign-in`
  const resetReturn = `${origin}/mikka/reset-password`
  const requestStart = new WeakMap<Request, number>()
  const report = options.report ?? (event => {
    // Never pass errors, recipients, URLs, tokens, or provider response bodies to a logger.
    if (event.outcome === 'failed') console.error('auth_email_delivery_failed', { kind: event.kind })
  })

  function callback(value: unknown, expected: string, allowDefault = true) {
    if (allowDefault && (value === undefined || value === '' || value === '/')) return expected
    if (!allowDefault && value !== expected) invalidLink('callback')
    if (typeof value !== 'string' || value.includes('\\')) invalidLink()
    let url: URL
    try { url = new URL(value, origin) } catch { invalidLink() }
    if (url.href !== expected || url.username || url.password) invalidLink()
    return expected
  }

  async function send(kind: MailKind, data: MailData) {
    const key = options.apiKey()
    if (!key) unavailable()
    const context = await options.context()
    const window = Math.floor(Date.now() / 60_000)
    const allowed = await context.internalAdapter.reserveVerificationValue({
      identifier: `mikka-mail-rate:${kind}:${digest(data.user.email.toLowerCase())}:${window}`,
      value: 'reserved', expiresAt: new Date(Date.now() + 120_000),
    })
    if (!allowed) { report({ kind, outcome: 'throttled' }); return }
    const url = new URL(data.url)
    if (url.origin !== origin || url.username || url.password || url.hash) invalidLink()
    if (kind === 'verification') {
      if (url.pathname !== '/mikka/api/auth/verify-email' || url.searchParams.get('token') !== data.token) invalidLink()
      const nonce = randomBytes(16).toString('hex')
      const identifier = `mikka-mail-verify:${digest(`${data.token}\0${nonce}`)}`
      if (!await context.internalAdapter.reserveVerificationValue({
        identifier, value: JSON.stringify({ id: data.user.id, email: data.user.email.toLowerCase() }),
        expiresAt: new Date(Date.now() + AUTH_EMAIL_TTL_SECONDS * 1000),
      })) unavailable()
      url.searchParams.set('nonce', nonce)
      // A fixed destination also keeps direct auth.api calls inside this deployment.
      url.searchParams.set('callbackURL', verifyReturn)
    } else {
      if (url.pathname !== `/mikka/api/auth/reset-password/${encodeURIComponent(data.token)}`) invalidLink()
      callback(url.searchParams.get('callbackURL') ?? undefined, resetReturn)
      url.searchParams.set('callbackURL', resetReturn)
    }
    const subject = kind === 'verification' ? 'Verify your Mikka email address' : 'Reset your Mikka password'
    const deliver = async () => { try {
      const response = await (options.fetch ?? fetch)('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: AUTH_EMAIL_FROM, to: [data.user.email], subject,
          text: `${subject}\n\n${url.href}\n\nThis link expires in 15 minutes. If you did not request this, ignore this email.` }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error('delivery rejected') }
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || !result.id) throw new Error('delivery not accepted')
      report({ kind, outcome: 'accepted_by_provider' })
    } catch {
      report({ kind, outcome: 'failed' })
      if (!options.background) unavailable()
    } }
    if (options.background) {
      try { options.background(deliver) } catch { report({ kind, outcome: 'failed' }); unavailable() }
    } else {
      await deliver()
    }
  }

  return {
    emailVerification: {
      expiresIn: AUTH_EMAIL_TTL_SECONDS, sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false,
      sendVerificationEmail: async (data: MailData) => send('verification', data),
    } satisfies BetterAuthOptions['emailVerification'],
    emailAndPassword: {
      enabled: true, autoSignIn: true, resetPasswordTokenExpiresIn: AUTH_EMAIL_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async (data: MailData) => send('password-reset', data),
    } satisfies BetterAuthOptions['emailAndPassword'],
    rateLimit: { enabled: true, customRules: {
      '/send-verification-email': { window: 60, max: 3 },
      '/request-password-reset': { window: 60, max: 3 },
      '/verify-email': { window: 60, max: 10 },
      '/reset-password': { window: 60, max: 5 },
    } } satisfies BetterAuthOptions['rateLimit'],
    async before(ctx: HookContext) {
      if (ctx.request && ['/send-verification-email', '/request-password-reset'].includes(ctx.path ?? '')) requestStart.set(ctx.request, Date.now())
      if (['/send-verification-email', '/request-password-reset', '/reset-password'].includes(ctx.path ?? '') && ctx.request) {
        const requestOrigin = ctx.request.headers.get('origin')
        if ((requestOrigin && requestOrigin !== origin) || ctx.request.headers.get('sec-fetch-site') === 'cross-site') {
          throw new APIError('FORBIDDEN', { code: 'INVALID_ORIGIN', message: 'Invalid origin' })
        }
      }
      if (ctx.path === '/send-verification-email') callback(ctx.body?.callbackURL, verifyReturn)
      if (ctx.path === '/request-password-reset') callback(ctx.body?.redirectTo, resetReturn)
      if (ctx.path?.startsWith('/reset-password/')) callback(ctx.query?.callbackURL, resetReturn, false)
      if (['/send-verification-email', '/request-password-reset'].includes(ctx.path ?? '') && !options.apiKey()) unavailable()
      if (ctx.path !== '/verify-email') return
      const raw = ctx.request ? new URL(ctx.request.url).searchParams : null
      // Fixed booleans only: runtime logs already supply deployment/request IDs.
      // Never log the URL, parsed values, identifiers, or key fingerprints.
      console.info('auth_email_verification_input', {
        tokenIsString: typeof ctx.query?.token === 'string',
        nonceHasExpectedShape: typeof ctx.query?.nonce === 'string' && /^[a-f0-9]{32}$/.test(ctx.query.nonce),
        callbackMatches: ctx.query?.callbackURL === verifyReturn,
        rawTokenUnique: raw ? raw.getAll('token').length === 1 : null,
        rawNonceUnique: raw ? raw.getAll('nonce').length === 1 : null,
        rawTokenMatchesParsed: raw ? raw.get('token') === ctx.query?.token : null,
        rawNonceMatchesParsed: raw ? raw.get('nonce') === ctx.query?.nonce : null,
        contextSecretMatchesEnvironment: process.env.BETTER_AUTH_SECRET ? ctx.context.secret === process.env.BETTER_AUTH_SECRET : null,
      })
      callback(ctx.query?.callbackURL, verifyReturn, false)
      const token = ctx.query?.token
      const nonce = ctx.query?.nonce
      if (typeof token !== 'string' || token.length > 4096 || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) invalidLink('token_or_nonce_shape')
      let payload: Record<string, unknown> | null
      try { payload = await verifyJWT<Record<string, unknown>>(token, ctx.context.secret) }
      catch { invalidLink('jwt_signature_or_expiry') }
      if (!payload) invalidLink('jwt_signature_or_expiry')
      if (typeof payload.email !== 'string' || payload.updateTo || payload.requestType || typeof payload.exp !== 'number' || payload.exp > Date.now() / 1000 + AUTH_EMAIL_TTL_SECONDS + 5) invalidLink('jwt_claims')
      const email = payload.email.toLowerCase()
      const identifier = `mikka-mail-verify:${digest(`${token}\0${nonce}`)}`
      const issued = await ctx.context.internalAdapter.findVerificationValue(identifier)
      if (!issued || new Date(issued.expiresAt).getTime() <= Date.now()) invalidLink('issuance_missing_or_expired')
      let binding: { id: string; email: string }
      try { binding = JSON.parse(issued.value) } catch { invalidLink() }
      const user = await ctx.context.internalAdapter.findUserById(binding.id)
      if (!user || user.emailVerified || user.email.toLowerCase() !== email || binding.email !== email) invalidLink('owner_binding')
      const original = ctx.context.internalAdapter
      // Scope the library's later lookup/write to the immutable issuance owner.
      // Do not mutate the shared adapter. Keep the library's hooks/cache handling.
      return { context: { context: { internalAdapter: {
        ...original,
        findUserByEmail: async (requestedEmail: string) => {
          if (requestedEmail.toLowerCase() !== binding.email) invalidLink()
          const current = await original.findUserById(binding.id)
          if (!current || current.emailVerified || current.email.toLowerCase() !== binding.email) invalidLink()
          return { user: current, accounts: [] }
        },
        updateUserByEmail: async (requestedEmail: string, data: Partial<User> & Record<string, unknown>) => {
          if (requestedEmail.toLowerCase() !== binding.email) invalidLink()
          // Use Better Auth's transaction context so nonce consumption and the
          // database update commit or roll back together. Better Auth still runs
          // its after-commit hooks and cache invalidation at their normal boundary.
          if (ctx.context.adapter.options?.adapterConfig.transaction === false) unavailable()
          return runWithTransaction(ctx.context.adapter, async () => {
            const consumed = await original.consumeVerificationValue(identifier)
            if (!consumed || consumed.value !== issued.value) invalidLink()
            const owner = await original.findUserById(binding.id)
            if (!owner || owner.emailVerified || owner.email.toLowerCase() !== binding.email) invalidLink()
            const current = await original.updateUser(binding.id, data)
            if (!current || current.id !== binding.id || current.email.toLowerCase() !== binding.email || !current.emailVerified) invalidLink()
            return current
          })
        },
      } } } }
    },
    async publicRequestResult(path: string | undefined, result: unknown, request?: Request) {
      if (!['/send-verification-email', '/request-password-reset'].includes(path ?? '')) return undefined
      const success = result && typeof result === 'object' && 'status' in result && result.status === true
      const deliveryFailure = result instanceof APIError && result.body?.code === 'AUTH_EMAIL_DELIVERY_UNAVAILABLE'
      if (!success && !deliveryFailure) return undefined
      const start = request && requestStart.get(request)
      if (start !== undefined) {
        const remaining = 500 - (Date.now() - start)
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      }
      // Same public outcome for unknown/verified/eligible addresses and delivery failures.
      // This is NOT a delivery receipt or a promise to retry. Failures are reported server-side.
      return { status: true, delivery: 'unconfirmed' as const, message: 'Request processed. This response does not confirm whether an email was sent.' }
    },
    base,
  }
}
