import { z } from 'zod'
import { canonicalOrigin, CredentialError, secretText, submitSchema } from './contracts'
import { checkCredentialRequest, credentialBody, credentialFailure, privateHeaders } from './http'
import { credentialActor, credentialStore, login } from './runtime'
import { resolveSubagentBrowserTarget } from '@/lib/cloud-computer/subagent-browser'

export async function subagentCredentialRoute(request: Request, botId: string, subagentId: string, action: 'challenge' | 'submit' | 'login') {
  try {
    checkCredentialRequest(request)
    if (!z.uuid().safeParse(botId).success || !z.uuid().safeParse(subagentId).success) throw new CredentialError('credential_denied', 404)
    const caller = { ...await credentialActor(request), botId, subagentId }
    await credentialStore.authorize(caller)
    if (action === 'submit') {
      const parsed = submitSchema.safeParse(await credentialBody(request))
      if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
      // Resolve the actual browser before accepting an account/site binding.
      const target = await resolveSubagentBrowserTarget(caller)
      if (canonicalOrigin(target.origin) !== canonicalOrigin(parsed.data.origin)) throw new CredentialError('credential_denied', 404)
      await credentialStore.save(caller, parsed.data)
      parsed.data.password = ''
      const result = await login(caller, target.origin)
      return Response.json(result, { headers: privateHeaders })
    }
    const parsed = z.object({ site: z.string().max(2048) }).strict().safeParse(await credentialBody(request))
    if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
    const target = await resolveSubagentBrowserTarget(caller)
    if (canonicalOrigin(target.origin) !== canonicalOrigin(parsed.data.site)) throw new CredentialError('credential_denied', 404)
    const result = action === 'challenge' ? await credentialStore.challenge(caller, target.origin) : await login(caller, target.origin)
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
