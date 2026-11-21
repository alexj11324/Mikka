import { internalEveHeaders } from '../eve/auth'
import { slackGrantProof } from './grant-proof'
import type { EveScope } from '../eve/scope'

export type SlackGrantScope = EveScope & { installationId: string; linkId: string; teamId: string; slackUserId: string }

/** Uncached native credential callback. Only the business service opens the workspace ciphertext. */
export async function nativeSlackToken(scope: SlackGrantScope) {
  const hosted = process.env.MIKKA_EVE_HOST === 'cloudflare'
  const origin = hosted
    ? 'https://product.internal'
    : (process.env.MIKKA_APP_ORIGIN ?? process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:3000')
  const capability = hosted ? process.env.MIKKA_EVE_PRODUCT_TOKEN : undefined
  if (hosted && !capability) throw new Error('slackUnavailable')
  const internal = internalEveHeaders({
    ownerId: scope.ownerId,
    workspaceId: scope.workspaceId,
    botId: scope.botId,
    surface: 'slack',
  })
  const response = await fetch(new URL('/mikka/api/internal/eve/slack-credential', origin), {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      ...internal,
      'x-mikka-slack-grant': slackGrantProof(internal.authorization ?? internal['x-mikka-eve-scope'], scope),
      'content-type': 'application/json',
      ...(capability ? { 'x-mikka-product-capability': capability } : {}),
    },
    body: JSON.stringify({
      installationId: scope.installationId,
      linkId: scope.linkId,
      teamId: scope.teamId,
      slackUserId: scope.slackUserId,
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('slackInstallNotAuthorized')
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || !('token' in data) || typeof data.token !== 'string' || !data.token)
    throw new Error('slackInstallNotAuthorized')
  return data.token
}
