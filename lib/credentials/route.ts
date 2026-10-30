import { z } from 'zod'
import { canonicalOrigin, CredentialError, secretText, submitSchema, codeSchema } from './contracts'
import { checkCredentialRequest, credentialBody, credentialFailure, privateHeaders } from './http'
import { credentialActor, credentialStore, login, loginAttempts, resolveCredentialBrowser } from './runtime'
import { loginAttemptsTable, type LoginAttemptView } from './login-attempts'
import { pool } from '@/lib/db'

export async function subagentCredentialRoute(request: Request, botId: string, subagentId: string, action: 'challenge' | 'submit' | 'login') {
  return browserCredentialRoute(request, { botId, subagentId }, action)
}

export async function threadCredentialRoute(request: Request, runId: string, action: 'challenge' | 'submit' | 'login') {
  try {
    const actor = await credentialActor(request)
    if (!z.uuid().safeParse(runId).success) throw new CredentialError('credential_denied', 404)
    const row = (await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, actor.userId])).rows[0]
    if (!row?.botId) throw new CredentialError('credential_denied', 404)
    return browserCredentialRoute(request, { botId: row.botId, runId }, action)
  } catch (error) { return credentialFailure(error) }
}

async function browserCredentialRoute(request: Request, identity: { botId: string; subagentId?: string; runId?: string }, action: 'challenge' | 'submit' | 'login') {
  try {
    checkCredentialRequest(request)
    if (!z.uuid().safeParse(identity.botId).success || !z.uuid().safeParse(identity.subagentId ?? identity.runId).success) throw new CredentialError('credential_denied', 404)
    const caller = { ...await credentialActor(request), ...identity }
    await credentialStore.authorize(caller)
    if (action === 'submit') {
      const parsed = z.union([submitSchema, codeSchema]).safeParse(await credentialBody(request))
      if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
      if ('code' in parsed.data) {
        // needs_code: only the code, typed into the same live session.
        let attempt: LoginAttemptView
        try { attempt = await loginAttempts.submitCode(caller, parsed.data.attemptId, parsed.data.code) } finally { parsed.data.code = '' }
        return Response.json(attemptBody(attempt), { headers: privateHeaders })
      }
      // Resolve the actual browser before accepting an account/site binding.
      const target = await resolveCredentialBrowser(caller)
      if (canonicalOrigin(target.origin) !== canonicalOrigin(parsed.data.origin)) throw new CredentialError('credential_denied', 404)
      // The card's challenge is consumed now; the credential is NOT saved until signed_in.
      await credentialStore.consumeChallenge(caller, parsed.data.nonce, target.origin)
      let attempt: LoginAttemptView
      try { attempt = await loginAttempts.start(caller, { origin: target.origin, username: parsed.data.username, password: parsed.data.password }) } finally { parsed.data.password = '' }
      return Response.json(attemptBody(attempt), { headers: privateHeaders })
    }
    const parsed = z.object({ site: z.string().max(2048), ...(action === 'login' ? { forcePassword: z.boolean().optional() } : {}) }).strict().safeParse(await credentialBody(request))
    if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
    const target = await resolveCredentialBrowser(caller)
    if (canonicalOrigin(target.origin) !== canonicalOrigin(parsed.data.site)) throw new CredentialError('credential_denied', 404)
    const result = action === 'challenge' ? await credentialStore.challenge(caller, target.origin) : await login(caller, target.origin, undefined, { forcePassword: 'forcePassword' in parsed.data && parsed.data.forcePassword === true })
    return Response.json(result, { headers: privateHeaders })
  } catch (error) { return credentialFailure(error) }
}

/** Never echoes username, password or code. */
export function attemptBody(attempt: LoginAttemptView) {
  return { attemptId: attempt.attemptId, status: attempt.status, ...(attempt.reason ? { reason: attempt.reason } : {}), origin: attempt.site, expiresAt: attempt.expiresAt }
}

/** GET …/credentials/attempts/:attemptId — one read-only SELECT on login_attempts,
 * scoped to the signed-in owner + workspace (+ this bot/subagent or run); else 404. */
export async function loginAttemptRoute(request: Request, identity: { botId?: string; subagentId?: string; runId?: string }, attemptId: string) {
  try {
    const actor = await credentialActor(request)
    for (const id of [identity.botId, identity.subagentId, identity.runId]) if (id !== undefined && !z.uuid().safeParse(id).success) throw new CredentialError('credential_denied', 404)
    return Response.json(attemptBody(await loginAttemptsTable.read(pool, actor, attemptId, identity)), { headers: privateHeaders })
  } catch (error) { return credentialFailure(error) }
}

export async function savedCredentialsRoute(request: Request) {
  try {
    const actor = await credentialActor(request)
    if (request.method === 'GET') return Response.json({ logins: await credentialStore.list(actor) }, { headers: privateHeaders })
    checkCredentialRequest(request)
    const parsed = z.object({ origin: z.string().max(2048), username: secretText }).strict().safeParse(await credentialBody(request))
    if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
    return Response.json(await credentialStore.remove(actor, parsed.data.origin, parsed.data.username), { headers: privateHeaders })
  } catch (error) { return credentialFailure(error) }
}
