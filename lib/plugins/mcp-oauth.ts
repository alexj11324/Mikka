import { createHash, randomBytes } from 'node:crypto'
import { auth, type OAuthAuthorizationServerInformation, type OAuthClientInformation, type OAuthClientMetadata, type OAuthClientProvider, type OAuthTokens } from '@ai-sdk/mcp'
import type { Pool, PoolClient } from 'pg'
import { openSecret, sealSecret } from '@/lib/secrets/crypto'
import { resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import { PluginError } from './contracts'
import { publicMcpFetch } from './public-fetch'

type Credentials = {
  client?: OAuthClientInformation; tokens?: OAuthTokens; verifier?: string;
  authorizationServer?: OAuthAuthorizationServerInformation; redirectUrl: string;
  expiresAt?: number; authorizationUrl?: string; state?: string;
}
type Row = { ciphertext: string; iv: string; key_version: number; state_digest: string | null; state_expires_at: Date | null }
const aad = (userId: string, serverId: string) => JSON.stringify(['mcp-oauth', userId, serverId])
const digest = (state: string) => createHash('sha256').update(state).digest('hex')

/** SDK discovery may use a distinct authorization-server origin. Every request
 * still uses the existing DNS-pinned public transport and rejects redirects. */
export function mcpOAuthTransport() {
  const signal = AbortSignal.timeout(25_000)
  const transports = new Map<string, ReturnType<typeof publicMcpFetch>>()
  return {
    fetch: (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      let transport = transports.get(url.origin)
      if (!transport) { transport = publicMcpFetch(url.origin, signal); transports.set(url.origin, transport) }
      return transport.fetch(input, init)
    }) as typeof fetch,
    close: () => Promise.allSettled([...transports.values()].map(transport => transport.close())),
  }
}

/** Persistence adapter for the SDK's native OAuth code/PKCE/discovery/refresh. */
export class McpOAuthStore {
  constructor(readonly pool: Pool, readonly env: Record<string, string | undefined> = process.env,
    readonly transport: () => { fetch: typeof fetch; close: () => Promise<unknown> } = mcpOAuthTransport) {}

  callbackUrl(serverId: string) {
    const origin = resolveAppOrigin(this.env)
    if (!origin) throw new PluginError('mcpOAuthOriginUnavailable', 503)
    return new URL(withBasePath(`/api/integrations/mcp/${serverId}/oauth/callback`), origin).href
  }

  private read(row: Row, userId: string, serverId: string): Credentials {
    return JSON.parse(openSecret({ ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version }, aad(userId, serverId), this.env))
  }

  private async save(client: PoolClient, userId: string, serverId: string, data: Credentials, stateExpires: Date | null) {
    const sealed = sealSecret(JSON.stringify(data), aad(userId, serverId), this.env)
    await client.query(`INSERT INTO personal_mcp_oauth(server_id,ciphertext,iv,key_version,state_digest,state_expires_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(server_id) DO UPDATE SET ciphertext=$2,iv=$3,key_version=$4,state_digest=$5,state_expires_at=$6,updated_at=now()`,
    [serverId, sealed.ciphertext, sealed.iv, sealed.keyVersion, data.state ? digest(data.state) : null, stateExpires])
  }

  private async locked<T>(userId: string, serverId: string, work: (client: PoolClient, url: string, row?: Row) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [server] } = await client.query<{ url: string; transport: string }>('SELECT url,transport FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, userId])
      if (!server) throw new PluginError('mcpNotFound', 404)
      if (server.transport === 'stdio') throw new PluginError('mcpOAuthNotSupported', 400)
      const { rows: [row] } = await client.query<Row>('SELECT * FROM personal_mcp_oauth WHERE server_id=$1 FOR UPDATE', [serverId])
      const result = await work(client, server.url, row)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  private provider(data: Credentials): OAuthClientProvider {
    const metadata: OAuthClientMetadata = { client_name: 'Mikka', redirect_uris: [data.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
    return {
      redirectUrl: data.redirectUrl, clientMetadata: metadata,
      tokens: () => data.tokens,
      saveTokens: tokens => { data.tokens = { ...tokens, ...(tokens.refresh_token ? {} : data.tokens?.refresh_token ? { refresh_token: data.tokens.refresh_token } : {}) }; data.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000 },
      clientInformation: () => data.client,
      isClientInformationDynamicallyRegistered: () => true,
      saveClientInformation: value => { data.client = value },
      authorizationServerInformation: () => data.authorizationServer,
      saveAuthorizationServerInformation: value => { data.authorizationServer = value },
      saveCodeVerifier: value => { data.verifier = value },
      codeVerifier: () => { if (!data.verifier) throw new PluginError('mcpOAuthStateInvalid', 400); return data.verifier },
      redirectToAuthorization: url => { data.authorizationUrl = url.href },
      state: () => data.state ??= randomBytes(32).toString('base64url'),
      saveState: value => { data.state = value }, storedState: () => data.state,
      invalidateCredentials: (scope, context) => {
        if (scope === 'all' || scope === 'client') delete data.client
        if ((scope === 'all' || scope === 'tokens') && (!context || data.tokens?.access_token === context.tokens.access_token)) { delete data.tokens; delete data.expiresAt }
        if (scope === 'all' || scope === 'verifier') delete data.verifier
      },
    }
  }

  async start(userId: string, serverId: string) {
    return this.locked(userId, serverId, async (client, url, row) => {
      const data = row ? this.read(row, userId, serverId) : { redirectUrl: this.callbackUrl(serverId) }
      data.redirectUrl = this.callbackUrl(serverId)
      data.state = randomBytes(32).toString('base64url')
      delete data.authorizationUrl
      const transport = this.transport()
      try { await auth(this.provider(data), { serverUrl: url, fetchFn: transport.fetch }) }
      catch { throw new PluginError('mcpOAuthUnavailable', 503) }
      finally { await transport.close() }
      if (!data.authorizationUrl) { delete data.state; delete data.verifier }
      await this.save(client, userId, serverId, data, data.authorizationUrl ? new Date(Date.now() + 600_000) : null)
      await client.query(`UPDATE personal_mcp_servers SET oauth_enabled=true,connection_status=$3,check_failure=NULL,revision=revision+1 WHERE id=$1 AND user_id=$2`, [serverId, userId, data.authorizationUrl ? 'needs_connect' : 'connected'])
      return { status: data.authorizationUrl ? 'needs_connect' as const : 'connected' as const, authorizationUrl: data.authorizationUrl ?? null }
    })
  }

  async callback(userId: string, serverId: string, input: { code: string; state: string; issuer?: string }) {
    if (!input.code || input.code.length > 4096 || input.state.length > 256) throw new PluginError('mcpOAuthStateInvalid', 400)
    return this.locked(userId, serverId, async (client, url, row) => {
      if (!row?.state_digest || row.state_digest !== digest(input.state) || !row.state_expires_at || row.state_expires_at.getTime() <= Date.now()) throw new PluginError('mcpOAuthStateInvalid', 400)
      const data = this.read(row, userId, serverId)
      const transport = this.transport()
      try { await auth(this.provider(data), { serverUrl: url, authorizationCode: input.code, callbackState: input.state, callbackIssuer: input.issuer, fetchFn: transport.fetch }) }
      catch { throw new PluginError('mcpOAuthExchangeFailed', 400) }
      finally { await transport.close() }
      delete data.verifier; delete data.state; delete data.authorizationUrl
      await this.save(client, userId, serverId, data, null)
      await client.query(`UPDATE personal_mcp_servers SET oauth_enabled=true,connection_status='connected',check_failure=NULL,revision=revision+1 WHERE id=$1 AND user_id=$2`, [serverId, userId])
      return { status: 'connected' as const, authorizationUrl: null }
    })
  }

  /** A row lock serializes token rotation. Credentials never leave this method
   * except the bearer handed to an already-authorized native MCP connection. */
  async accessToken(userId: string, serverId: string): Promise<string> {
    const result = await this.locked(userId, serverId, async (client, url, row) => {
      if (!row) return null
      const data = this.read(row, userId, serverId)
      if (data.tokens?.access_token && (data.expiresAt === undefined || data.expiresAt > Date.now() + 30_000)) return data.tokens.access_token
      if (!data.tokens?.refresh_token) return null
      const transport = this.transport()
      try { await auth(this.provider(data), { serverUrl: url, fetchFn: transport.fetch }) }
      catch { return null }
      finally { await transport.close() }
      await this.save(client, userId, serverId, data, data.authorizationUrl ? new Date(Date.now() + 600_000) : null)
      if (data.authorizationUrl || !data.tokens?.access_token) {
        await client.query(`UPDATE personal_mcp_servers SET connection_status='needs_connect',check_failure='oauthReconnectRequired' WHERE id=$1`, [serverId])
        return null
      }
      return data.tokens.access_token
    })
    if (!result) throw new PluginError('mcpNeedsConnect', 409)
    return result
  }

  async authorizationUrl(userId: string, serverId: string): Promise<string | null> {
    const { rows: [row] } = await this.pool.query<Row>(`SELECT o.* FROM personal_mcp_oauth o JOIN personal_mcp_servers s ON s.id=o.server_id
      WHERE s.id=$1 AND s.user_id=$2 AND o.state_expires_at>now()`, [serverId, userId])
    return row ? this.read(row, userId, serverId).authorizationUrl ?? null : null
  }
}
