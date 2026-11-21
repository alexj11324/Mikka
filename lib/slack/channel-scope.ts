import { AsyncLocalStorage } from 'node:async_hooks'
import { defineState } from 'eve/context'
import type { AuthResult } from 'eve/channels/auth'
import { z } from 'zod'
import { eveScopeSchema } from '../eve/scope'
import { slackTeamId, slackUserId } from './install-provider'
import type { SlackGrantScope } from './channel-grant'

const installation = eveScopeSchema.extend({
  surface: z.literal('slack'),
  installationId: z.uuid(),
  linkId: z.uuid(),
  teamId: z.string().refine(slackTeamId),
  slackUserId: z.string().refine(slackUserId),
})
export const slackRequest = new AsyncLocalStorage<SlackGrantScope>()
// Only Mikka's non-secret coordinates survive suspension in Eve's own session state.
const current = defineState<SlackGrantScope | null>('mikka.slack.installation', () => null)
export function stampSlackSession(auth: AuthResult | null | undefined) {
  const parsed =
    auth?.authenticator === 'mikka' && auth.principalType === 'user'
      ? installation.safeParse({ ...auth.attributes, ownerId: auth.principalId })
      : null
  current.update(() => (parsed?.success ? parsed.data : null))
}
export function activeSlackGrant() {
  const inbound = slackRequest.getStore()
  if (inbound) return inbound
  // Outside a signed request or actual Eve session, defineState fails closed.
  return current.get()
}
