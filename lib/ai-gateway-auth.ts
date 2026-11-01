/**
 * The app's one AI Gateway credential, resolved the way the AI SDK's gateway
 * provider resolves it for every model call (the Coordinator's included):
 * AI_GATEWAY_API_KEY where it is set (local, CI), otherwise the Vercel
 * deployment's OIDC token. Callers that talk to the gateway without the SDK
 * (the Decisions route) use this, so there is no second key. Null when
 * neither exists.
 */
export interface GatewayAuth { token: string; method: 'api-key' | 'oidc' }

export async function gatewayAuth(
  env: Record<string, string | undefined> = process.env,
  oidc: () => Promise<string> = async () => (await import('@vercel/oidc')).getVercelOidcToken(),
): Promise<GatewayAuth | null> {
  if (env.AI_GATEWAY_API_KEY) return { token: env.AI_GATEWAY_API_KEY, method: 'api-key' }
  try {
    const token = await oidc()
    return token ? { token, method: 'oidc' } : null
  } catch { return null }
}
