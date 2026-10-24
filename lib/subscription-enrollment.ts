// Server custody only. No model, native runner, SQL or execution-reader import.
import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const status = z.object({ id: z.uuid(), provider: z.literal('claude'), state: z.enum(['pending_unbound', 'custody_unconfirmed']), taskUseAllowed: z.literal(false) }).strict()
const started = z.object({ id: z.uuid(), provider: z.literal('claude'), state: z.literal('awaiting_consent'), taskUseAllowed: z.literal(false), authorizationUrl: z.url(), expiresAt: z.iso.datetime() }).strict()
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('complete'), id: z.uuid(), callbackUrl: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.literal('status'), id: z.uuid() }).strict(),
])
export interface EnrollmentConfiguration {
  binary: string
  infisicalOrigin: string
  project: string
  environment: string
  workloadToken: string
  attemptPath: string
  claimPath: string
  grantPath: string
  databaseUrl?: string
  canonicalGrantPath?: string
  accessPath?: string
}
export function enrollmentOperator(request: Request, token: string | undefined): string | null {
  if (!token || token.length < 32) return null
  const expected = Buffer.from(`Bearer ${token}`)
  const supplied = Buffer.from(request.headers.get('authorization') ?? '')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
  // This is an operator principal, never a fabricated authenticated Mikka user.
  return `operator:${createHash('sha256').update(token).digest('hex')}`
}
export class EnrollmentClient {
  constructor(private readonly config: EnrollmentConfiguration) {}
  async call(principal: string, body: z.infer<typeof input>) {
    return this.invoke(principal, { method: body.action, ...('id' in body ? { id: body.id } : {}), ...('callbackUrl' in body ? { callbackUrl: body.callbackUrl } : {}) }, body.action === 'start' ? started : status)
  }
  async bind(principal: string, id: string, ownerId: string, workspaceId: string) {
    const sourceCleanup = z.object({ pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), protected: z.number().int().nonnegative(), uncertainCreates: z.number().int().nonnegative(), state: z.enum(['complete', 'awaiting_publication', 'configuration_required', 'ownership_unconfirmed', 'creation_outcome_unknown', 'deletion_failed', 'pending']) }).strict()
    const cleanup = z.object({ pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), providerRevocation: z.literal('not_implemented'), uncertainCreates: z.number().int().nonnegative(), enrollment: sourceCleanup.optional() }).strict()
    return this.invoke(principal, { method: 'bind', id, ownerId, workspaceId }, z.object({ id: z.uuid(), provider: z.literal('claude'), state: z.literal('connected'), revision: z.number().int().positive(), credentialVersion: z.number().int().positive(), cleanup: cleanup.optional() }).strict())
  }
  private async invoke(principal: string, request: Record<string, string>, schema: z.ZodType) {
    const { binary, ...config } = this.config
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'production' }
    // Honor the platform's normal proxy/CA controls; no provider/local CLI
    // credentials, database URL, HOME or unrelated platform keys are inherited.
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[name]) env[name] = process.env[name]
    const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    return await new Promise<unknown>((resolve, reject) => {
      let raw = '', settled = false
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); child.kill('SIGTERM'); reject(new Error('subscription_enrollment_unavailable')) } }
      // Persistence after exchange is bounded in Go. A disconnected browser does
      // not kill the custody process before its grant publication can finish.
      const timer = setTimeout(fail, 100_000)
      child.on('error', fail); child.stdin.on('error', fail)
      child.stdout.on('data', part => { raw += String(part); if (raw.length > 32768) fail() })
      child.on('exit', code => {
        if (settled) return
        try {
          if (code !== 0) throw new Error()
          const frame = JSON.parse(raw)
          const result = schema.parse(frame.result) as Record<string, unknown>
          if (typeof result.authorizationUrl === 'string') {
            const target = new URL(result.authorizationUrl)
            if (target.origin !== 'https://claude.ai' || target.pathname !== '/oauth/authorize' || target.hash || target.username || target.password) throw new Error()
          }
          settled = true; clearTimeout(timer); resolve(result)
        } catch { fail() }
      })
      child.stdin.end(`${JSON.stringify({ ...config, principal })}\n${JSON.stringify(request)}\n`)
    })
  }
}
export function enrollmentHTTP(deps: { authorize(request: Request): Promise<string | null>; client(): Pick<EnrollmentClient, 'call'> }) {
  return async (request: Request) => {
    const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }
    try {
      if (request.method !== 'POST' || request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin)) return Response.json({ error: 'request_refused' }, { status: 403, headers })
      const principal = await deps.authorize(request)
      if (!principal) return Response.json({ error: 'auth_required' }, { status: 401, headers })
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'invalid_request' }, { status: 415, headers })
      const reader = request.body?.getReader()
      if (!reader) throw new Error()
      const chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 12000) { await reader.cancel(); throw new Error() }; chunks.push(value) } } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const body = input.parse(JSON.parse(new TextDecoder().decode(bytes)))
      return Response.json(await deps.client().call(principal, body), { headers })
    } catch { return Response.json({ error: 'subscription_enrollment_unavailable' }, { status: 409, headers }) }
  }
}
