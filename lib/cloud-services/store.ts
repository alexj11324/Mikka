import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { openSecret, sealSecret, type Sealed } from '@/lib/secrets/crypto'
import { cloudEndpoint, cloudServiceUrl, selfHostedAddress } from './config'
import { CloudServiceError } from './errors'
import { cloudJson, parseCloudToken, readCloudJson } from './transport'
import { AVAILABLE_CLOUD_SCOPES, type CloudConnectionView, type CloudRegistration, type CloudScope, type CloudToken } from './types'
import { remainingRequestBudget, requestBudgetSignal, type RequestBudget } from '../request-budget'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const opaque = () => randomBytes(32).toString('base64url')
const aad = (kind: string, id: string) => ['cloud_service_client', kind, id].join('\0')
type RegistrationRow = { server_id: string; origin: string; base_path: string; service_url: string; secret: Sealed }
type BindingRow = { owner: string; server_id: string; secret: Sealed; scopes: CloudScope[]; revoked: boolean }
type BindingSecret = { token?: CloudToken; serverKey?: string }
type Database = Pick<PoolClient, 'query'>

/** All replicas share row locks when rotating refresh tokens. A cached token
 * is encrypted in the DB, so a second replica cannot reuse an old refresh. */
export class CloudClientStore {
  constructor(private pool: Pick<Pool, 'connect' | 'query'>, private env: Record<string, string | undefined> = process.env, private send: typeof fetch = fetch) {}

  private seal(value: unknown, kind: string, id: string) { return sealSecret(JSON.stringify(value), aad(kind, id), this.env) }
  private open<T>(value: Sealed, kind: string, id: string): T {
    try { return JSON.parse(openSecret(value, aad(kind, id), this.env)) as T }
    catch (error) { throw new CloudServiceError('cloud_unavailable', 'storage', error) }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T | CloudServiceError>): Promise<T> {
    const client = await this.pool.connect(); let committed = false
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT'); committed = true
      // Some failures deliberately persist a revoked binding before refusing.
      if (result instanceof CloudServiceError) throw result
      return result
    } catch (error) { if (!committed) await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  async registration(database: Database = this.pool): Promise<CloudRegistration | null> {
    const { rows: [row] } = await database.query<RegistrationRow>('SELECT server_id,origin,base_path,service_url,secret FROM cloud_service_registration WHERE id=true')
    if (!row) return null
    const expected = selfHostedAddress(this.env)
    if (row.service_url !== cloudServiceUrl(this.env) || row.origin !== expected.origin || row.base_path !== expected.basePath) throw new CloudServiceError('cloud_invalid_request', 'configuration')
    return { serverId: row.server_id, origin: row.origin, basePath: row.base_path, serviceUrl: row.service_url,
      serverSecret: this.open<{ serverSecret: string }>(row.secret, 'registration', row.server_id).serverSecret }
  }

  async register(name: string) {
    if (!name.trim() || name.length > 100) throw new CloudServiceError('cloud_invalid_request', 'configuration')
    return this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka_cloud_client_registration',0))")
      const current = await this.registration(client); if (current) return { serverId: current.serverId }
      const { origin, basePath, redirectUri } = selfHostedAddress(this.env)
      const serviceUrl = cloudServiceUrl(this.env)
      const value = await cloudJson(serviceUrl, '/v1/servers/register', { origin, basePath, name: name.trim() }, this.send)
      if (typeof value.serverId !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value.serverId)
        || typeof value.serverSecret !== 'string' || !/^mcs_[A-Za-z0-9_-]{43}$/.test(value.serverSecret) || value.redirectUri !== redirectUri
        || value.tokenEndpoint !== cloudEndpoint(serviceUrl, '/oauth/token') || value.authorizationEndpoint !== cloudEndpoint(serviceUrl, '/oauth/authorize')) throw new CloudServiceError('cloud_unavailable', 'protocol')
      const sealed = this.seal({ serverSecret: value.serverSecret }, 'registration', value.serverId)
      await client.query('INSERT INTO cloud_service_registration (server_id,origin,base_path,service_url,secret) VALUES ($1,$2,$3,$4,$5)', [value.serverId, origin, basePath, serviceUrl, sealed])
      return { serverId: value.serverId }
    })
  }

  async beginBinding(userId: string, sessionId: string, scopes: readonly CloudScope[]) {
    if (!scopes.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !(AVAILABLE_CLOUD_SCOPES as readonly CloudScope[]).includes(scope))) throw new CloudServiceError('cloud_invalid_request', 'protocol')
    const registration = await this.registration(); if (!registration) throw new CloudServiceError('cloud_not_connected')
    const state = opaque(), verifier = opaque(), stateHash = digest(state)
    await this.pool.query('DELETE FROM cloud_service_states WHERE expires_at < now() OR user_id=$1', [userId])
    await this.pool.query(`INSERT INTO cloud_service_states (state_hash,user_id,session_hash,server_id,secret,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '10 minutes')`,
      [stateHash, userId, digest(sessionId), registration.serverId, this.seal({ verifier, scopes }, 'state', stateHash)])
    const query = new URLSearchParams({ response_type: 'code', client_id: registration.serverId,
      redirect_uri: `${registration.origin}${registration.basePath}/api/cloud/callback`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: scopes.join(' '), state })
    return { url: `${cloudEndpoint(registration.serviceUrl, '/oauth/authorize')}?${query}` }
  }

  async completeBinding(userId: string, sessionId: string, state: string, code: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 512) throw new CloudServiceError('cloud_invalid_request', 'state')
    const stateHash = digest(state)
    // Consumption commits before the network exchange: a replay never starts
    // another exchange, including when the first response was lost.
    const { rows: [pending] } = await this.pool.query<{ server_id: string; secret: Sealed }>(`DELETE FROM cloud_service_states WHERE state_hash=$1 AND user_id=$2 AND session_hash=$3 AND expires_at>now() RETURNING server_id,secret`, [stateHash, userId, digest(sessionId)])
    if (!pending) throw new CloudServiceError('cloud_invalid_request', 'state')
    const registration = await this.registration()
    if (!registration || registration.serverId !== pending.server_id) throw new CloudServiceError('cloud_not_connected')
    const { verifier, scopes } = this.open<{ verifier: string; scopes: CloudScope[] }>(pending.secret, 'state', stateHash)
    const value = await cloudJson(registration.serviceUrl, '/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.serverId, client_secret: registration.serverSecret,
      code, code_verifier: verifier, redirect_uri: `${registration.origin}${registration.basePath}/api/cloud/callback` }), this.send)
    const token = parseCloudToken(value, registration.serverId)
    if (token.grantType !== 'user' || token.scopes.some(scope => !scopes.includes(scope))) throw new CloudServiceError('cloud_unavailable', 'protocol')
    await this.saveBinding(`user:${userId}`, userId, registration.serverId, { token }, this.pool)
  }

  private async saveBinding(owner: string, userId: string | null, serverId: string, secret: BindingSecret, database: Database) {
    const sealed = this.seal(secret, 'binding', `${serverId}:${owner}`)
    await database.query(`INSERT INTO cloud_service_bindings (owner,user_id,server_id,secret,scopes) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (owner) DO UPDATE SET server_id=EXCLUDED.server_id,secret=EXCLUDED.secret,scopes=EXCLUDED.scopes,revoked=false,updated_at=now()`,
    [owner, userId, serverId, sealed, secret.token?.scopes ?? []])
    return sealed
  }

  async connectTeamKey(key: string) {
    if (!/^mkc_[A-Za-z0-9_-]{43}$/.test(key)) throw new CloudServiceError('cloud_invalid_request', 'protocol')
    const registration = await this.registration(); if (!registration) throw new CloudServiceError('cloud_not_connected')
    const value = await cloudJson(registration.serviceUrl, '/oauth/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: registration.serverId, client_secret: key }), this.send)
    const token = parseCloudToken(value, registration.serverId)
    if (token.grantType !== 'server_key') throw new CloudServiceError('cloud_unavailable', 'protocol')
    await this.saveBinding('server', null, registration.serverId, { serverKey: key, token }, this.pool)
  }

  async access(userId: string, scope: CloudScope, budget?: RequestBudget): Promise<{ token: CloudToken; registration: CloudRegistration; actor: string; binding: Pick<BindingRow, 'owner' | 'secret'> }> {
    if (budget) remainingRequestBudget(budget)
    const access = await this.transaction(async client => {
      if (budget) {
        const timeout = String(Math.min(2000, remainingRequestBudget(budget)))
        await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [timeout])
      }
      const registration = await this.registration(client); if (!registration) throw new CloudServiceError('cloud_not_connected')
      const { rows: [row] } = await client.query<BindingRow>(`SELECT owner,server_id,secret,scopes,revoked FROM cloud_service_bindings WHERE owner=ANY($1::text[]) ORDER BY CASE WHEN owner='server' THEN 1 ELSE 0 END LIMIT 1 FOR UPDATE`, [[`user:${userId}`, 'server']])
      if (!row) throw new CloudServiceError('cloud_not_connected')
      if (row.revoked || row.server_id !== registration.serverId) throw new CloudServiceError('cloud_server_revoked')
      if (!row.scopes.includes(scope)) throw new CloudServiceError('cloud_scope_missing')
      const secret = this.open<BindingSecret>(row.secret, 'binding', `${row.server_id}:${row.owner}`)
      let token = secret.token, bindingSecret = row.secret
      if (!token || token.expiresAt <= Date.now() + 60_000) {
        // Cancellation before a refresh must not enter the uncertain-refresh
        // catch below or revoke a still-valid binding. Once sent, drain its
        // independent 20s response and persist before observing UI abort.
        if (budget) remainingRequestBudget(budget, 22_000)
        const form = row.owner === 'server'
          ? new URLSearchParams({ grant_type: 'client_credentials', client_id: registration.serverId, client_secret: secret.serverKey ?? '' })
          : new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.serverId, client_secret: registration.serverSecret, refresh_token: token?.refreshToken ?? '' })
        try {
          token = parseCloudToken(await cloudJson(registration.serviceUrl, '/oauth/token', form, this.send), registration.serverId)
          if (token.grantType !== (row.owner === 'server' ? 'server_key' : 'user') || token.scopes.some(item => !row.scopes.includes(item))) throw new CloudServiceError('cloud_unavailable', 'protocol')
          bindingSecret = await this.saveBinding(row.owner, row.owner === 'server' ? null : userId, registration.serverId, { ...secret, token }, client)
        } catch (error) {
          // A lost rotating-refresh response cannot safely be replayed. Keep
          // the row to prevent silently switching this person's billing to a team.
          if (row.owner !== 'server' || (error instanceof CloudServiceError && error.code === 'cloud_server_revoked')) {
            await client.query('UPDATE cloud_service_bindings SET revoked=true,updated_at=now() WHERE owner=$1', [row.owner])
          }
          return error instanceof CloudServiceError ? error : new CloudServiceError('cloud_unavailable', 'refresh_uncertain', error)
        }
      }
      if (!token.scopes.includes(scope)) throw new CloudServiceError('cloud_scope_missing')
      return { token, registration, actor: createHmac('sha256', registration.serverSecret).update(userId).digest('hex'), binding: { owner: row.owner, secret: bindingSecret } }
    })
    if (budget) remainingRequestBudget(budget)
    return access
  }

  async request(userId: string, scope: CloudScope, path: string, init: RequestInit = {}, budget?: RequestBudget): Promise<Response> {
    if (budget) remainingRequestBudget(budget)
    const { token, registration, actor, binding } = await this.access(userId, scope, budget)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token.accessToken}`); headers.set('X-Mikka-Actor', actor)
    let response: Response
    try {
      const signal = budget ? requestBudgetSignal(budget, 60_000) : init.signal ?? AbortSignal.timeout(60_000)
      response = await this.send(cloudEndpoint(registration.serviceUrl, path), { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: budget && init.signal ? AbortSignal.any([signal, init.signal]) : signal })
    }
    catch (error) { throw new CloudServiceError('cloud_unavailable', 'network', error) }
    if (!response.ok) {
      try { await readCloudJson(response) }
      catch (error) {
        // A previous token's late response must not revoke a newer binding.
        // Compare the exact encrypted snapshot used for this request, including
        // any refresh committed by access(). No extra read or network request.
        if (error instanceof CloudServiceError && error.code === 'cloud_server_revoked') await this.pool.query('UPDATE cloud_service_bindings SET revoked=true,updated_at=now() WHERE owner=$1 AND server_id=$2 AND secret=$3::jsonb', [binding.owner, registration.serverId, binding.secret])
        throw error
      }
      throw new CloudServiceError('cloud_unavailable', 'response')
    }
    return response
  }

  async disconnect(userId: string, serverKey = false) {
    const owner = serverKey ? 'server' : `user:${userId}`
    await this.transaction(async client => {
      const { rows: [row] } = await client.query<BindingRow>('SELECT owner,server_id,secret,scopes,revoked FROM cloud_service_bindings WHERE owner=$1 FOR UPDATE', [owner])
      if (!row) return
      const registration = await this.registration(client)
      if (registration) {
        const secret = this.open<BindingSecret>(row.secret, 'binding', `${row.server_id}:${row.owner}`)
        const token = serverKey ? secret.serverKey : secret.token?.refreshToken ?? secret.token?.accessToken
        if (token) await cloudJson(registration.serviceUrl, '/oauth/revoke', new URLSearchParams({ client_id: registration.serverId, client_secret: serverKey ? secret.serverKey! : registration.serverSecret, token }), this.send)
      }
      await client.query('DELETE FROM cloud_service_bindings WHERE owner=$1', [owner])
    })
  }

  async disconnectServer() {
    await this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka_cloud_client_registration',0))")
      const registration = await this.registration(client)
      if (registration) await cloudJson(registration.serviceUrl, '/v1/servers/revoke', new URLSearchParams({ client_id: registration.serverId, client_secret: registration.serverSecret }), this.send)
      await client.query('DELETE FROM cloud_service_states')
      await client.query('DELETE FROM cloud_service_bindings')
      await client.query('DELETE FROM cloud_service_registration')
    })
  }

  async view(userId: string, administrator: boolean): Promise<CloudConnectionView> {
    const registration = await this.registration()
    const { rows } = await this.pool.query<BindingRow>('SELECT owner,scopes,revoked FROM cloud_service_bindings WHERE owner=ANY($1::text[])', [[`user:${userId}`, 'server']])
    const personal = rows.find(row => row.owner === `user:${userId}`), team = rows.find(row => row.owner === 'server')
    return { registered: Boolean(registration), serverId: administrator ? registration?.serverId ?? null : null, serviceUrl: cloudServiceUrl(this.env), administrator, pushContent: await this.pushContent(),
      team: { connected: Boolean(team && !team.revoked), scopes: team?.scopes ?? [] },
      personal: { connected: Boolean(personal && !personal.revoked), revoked: Boolean(personal?.revoked), scopes: personal?.scopes ?? [] } }
  }

  async pushContent(): Promise<'full' | 'reminder'> {
    const { rows: [row] } = await this.pool.query<{ push_content: 'full' | 'reminder' }>('SELECT push_content FROM cloud_service_registration WHERE id=true')
    return row?.push_content ?? 'full'
  }

  async setPushContent(value: 'full' | 'reminder'): Promise<void> {
    if (value !== 'full' && value !== 'reminder') throw new CloudServiceError('cloud_invalid_request', 'configuration')
    const result = await this.pool.query('UPDATE cloud_service_registration SET push_content=$1 WHERE id=true RETURNING server_id', [value])
    if (!result.rowCount) throw new CloudServiceError('cloud_not_connected')
  }

  /** Local capability readiness only. Keep the same personal-first selection as
   * access(): a personal binding without this scope never spends the team key. */
  async capability(userId: string, scope: CloudScope): Promise<{ serviceUrl: string } | null> {
    const { rows: [row] } = await this.pool.query<{ service_url: string; enabled: boolean }>(`SELECT r.service_url,
      (b.server_id=r.server_id AND NOT b.revoked AND $2=ANY(b.scopes)) AS enabled
      FROM cloud_service_registration r CROSS JOIN LATERAL (
        SELECT server_id,revoked,scopes FROM cloud_service_bindings WHERE owner=ANY($1::text[])
        ORDER BY CASE WHEN owner='server' THEN 1 ELSE 0 END LIMIT 1
      ) b WHERE r.id=true`, [[`user:${userId}`, 'server'], scope])
    return row?.enabled === true ? { serviceUrl: row.service_url } : null
  }

  async connected(): Promise<boolean> {
    const { rows: [row] } = await this.pool.query<{ connected: boolean }>(`SELECT EXISTS (SELECT 1 FROM cloud_service_bindings b JOIN cloud_service_registration r ON r.server_id=b.server_id WHERE b.revoked=false) AS connected`)
    return row?.connected === true
  }
}
