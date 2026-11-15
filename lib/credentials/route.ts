import { z } from 'zod'
import { canonicalOrigin, CredentialError, secretText, submitSchema, otpSchema, type Actor } from './contracts'
import { checkCredentialRequest, credentialBody, credentialFailure, privateHeaders } from './http'
import { credentialActor, credentialStore, login, executeCredentialLease, resolveCredentialBrowser } from './runtime'
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
    return browserCredentialRoute(request, { botId: row.botId, runId }, action, actor)
  } catch (error) { return credentialFailure(error) }
}

async function browserCredentialRoute(request: Request, identity: { botId: string; subagentId?: string; runId?: string }, action: 'challenge' | 'submit' | 'login', resolvedActor?: Actor) {
  try {
    checkCredentialRequest(request)
    if (!z.uuid().safeParse(identity.botId).success || !z.uuid().safeParse(identity.subagentId ?? identity.runId).success) throw new CredentialError('credential_denied', 404)
    const actor = resolvedActor ?? await credentialActor(request)
    const caller = { ...actor, ...identity }
    await credentialStore.authorize(caller)
    if (action === 'submit') {
      const parsed = z.union([submitSchema, otpSchema]).safeParse(await credentialBody(request))
      if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
      // Resolve the actual browser before accepting an account/site binding.
      const target = await resolveCredentialBrowser(caller)
      if (canonicalOrigin(target.origin) !== canonicalOrigin(parsed.data.origin)) throw new CredentialError('credential_denied', 404)
      if ('code' in parsed.data) {
        let lease: string
        try { lease = await credentialStore.otpLease(caller, parsed.data, target) } finally { parsed.data.code = '' }
        return Response.json(await executeCredentialLease(lease, target.origin, { ownerId: caller.userId, workspaceId: caller.workspaceId }), { headers: privateHeaders })
      }
      try { await credentialStore.save(caller, parsed.data) } finally { parsed.data.password = '' }
      const result = await login(caller, target.origin, parsed.data.username)
      return Response.json(result, { headers: privateHeaders })
    }
    const parsed = z.object({ site: z.string().max(2048), ...(action === 'login' ? { forcePassword: z.boolean().optional() } : {}) }).strict().safeParse(await credentialBody(request))
    if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
    const target = await resolveCredentialBrowser(caller)
    if (canonicalOrigin(target.origin) !== canonicalOrigin(parsed.data.site)) throw new CredentialError('credential_denied', 404)
    const result = action === 'challenge' ? await credentialStore.challenge(caller, target.origin) : await login(caller, target.origin, undefined, { forcePassword: 'forcePassword' in parsed.data && parsed.data.forcePassword === true })
    return Response.json(result, { headers: privateHeaders })
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
