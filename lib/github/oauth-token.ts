import 'server-only'

export type GitHubOAuthToken = { access_token: string; expires_in?: number; refresh_token?: string;
  refresh_token_expires_in?: number; token_type?: string; scope?: string }

/** Fixed origin and an independent deadline: abandoning a rotating token
 * exchange on a browser abort could lose the only usable refresh token. */
export async function exchangeGitHubOAuthToken(client: { clientId: string; clientSecret: string },
  params: Record<string, string>): Promise<GitHubOAuthToken> {
  let response: Response
  try { response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mikka' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
  // error-cause: OAuth transport errors can retain client secrets and rotating refresh tokens.
  }) } catch { throw new Error('GitHub token exchange failed') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('GitHub token exchange failed')
  try {
    const chunks: Uint8Array[] = []; let bytes = 0
    while (true) {
      const part = await reader.read(); if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 32 * 1024) throw new Error('GitHub token exchange failed')
      chunks.push(part.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub token exchange failed')
    const token = value as Record<string, unknown>
    const credential = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+=*$/.test(value)
    if (!credential(token.access_token) || (token.refresh_token !== undefined && !credential(token.refresh_token))
      || ['expires_in', 'refresh_token_expires_in'].some(key => token[key] !== undefined
        && (typeof token[key] !== 'number' || !Number.isSafeInteger(token[key]) || token[key] <= 0
          || !Number.isFinite(new Date(Date.now() + token[key] * 1000).getTime())))
      || (token.token_type !== undefined && (typeof token.token_type !== 'string' || token.token_type.length > 64))
      || (token.scope !== undefined && (typeof token.scope !== 'string' || token.scope.length > 4096))) throw new Error('GitHub token exchange failed')
    return token as GitHubOAuthToken
  } catch {
    await reader.cancel().catch(() => {})
    // error-cause: JSON and stream errors can quote the returned access or refresh token.
    throw new Error('GitHub token exchange failed')
  } finally { reader.releaseLock() }
}

/** Better Auth still owns legacy account encryption and persistence. This
 * replaces only its otherwise unbounded GitHub refresh HTTP request. */
export async function refreshGitHubOAuthToken(client: { clientId: string; clientSecret: string }, refreshToken: string) {
  const token = await exchangeGitHubOAuthToken(client, { grant_type: 'refresh_token', refresh_token: refreshToken })
  const now = Date.now()
  return { accessToken: token.access_token, refreshToken: token.refresh_token, tokenType: token.token_type,
    scopes: token.scope?.split(/[ ,]+/).filter(Boolean),
    ...(token.expires_in ? { accessTokenExpiresAt: new Date(now + token.expires_in * 1000) } : {}),
    ...(token.refresh_token_expires_in ? { refreshTokenExpiresAt: new Date(now + token.refresh_token_expires_in * 1000) } : {}) }
}
