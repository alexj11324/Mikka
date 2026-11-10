import 'server-only'
import { runMayUseCredentialSql } from './personal-policy'
import { infisicalWorkloadToken } from './infisical-workload'
import type { Pool } from 'pg'
import { CodedError, logCodedError } from '@mikka/protocol/coded-error'
import type { CredentialScope } from '../packages/daemon/src/subscription-worker-client'
import { currentSubscriptionWorkerTiming } from '../packages/daemon/src/subscription-worker-timing'

// Only an authorized connected row without a published projection may use the
// existing custody migration. A rejected lookup is never a preparation hint.
export class AccessProjectionMissing extends CodedError {
  constructor() { super('subscription_access_unavailable', { detail: 'projection_missing' }) }
}

export async function authorizedAccessName(database: Pick<Pool, 'query'>, scope: CredentialScope, use: { bindingId: string; consumerId: string; runId?: string }, revision: unknown,
  member: (userId: string, workspaceId: string, borrowerId?: string) => Promise<void> = async () => { throw new Error('subscription_access_unavailable') }, allowMissingProjection = false): Promise<string> {
  const timingDone = currentSubscriptionWorkerTiming()?.phase('parentAccessAuthority')
  try {
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error('subscription_access_unavailable')
    const { rows } = await database.query(`select c."accessSecretName"${allowMissingProjection ? ',c.state' : ''},b."workspaceId",(select r."userId" from agent_runs r where r.id=$8) as "runOwner" from byos_connections c join byos_bindings b on b."connectionId"=c.id where c.id=$1 and c."ownerId"=$2 and c."workspaceId"=$3 and c.provider=$4 and c.epoch=$5 and c.state in ('connected','refreshing','publication_pending') and b.id=$6 and b."ownerId"=$2 and b."consumerId"=$7 and b."connectionRevision"=$5 and ($8::uuid is null or exists(select 1 from agent_runs r join byos_native_runs n on n."runId"=r.id where r.id=$8 and ${runMayUseCredentialSql('$2', 'r."userId"', 'b."workspaceId"')} and r."agentId"::text=$7 and n."bindingId"=b.id and r.status in ('preparing','running','paused','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null))`, [scope.connectionId, scope.ownerId, scope.workspaceId, scope.provider, revision, use.bindingId, use.consumerId, use.runId ?? null])
    const row = rows[0]
    if (!row) throw new Error('subscription_access_unavailable')
    const name = row.accessSecretName
    if (typeof name !== 'string' && !allowMissingProjection) throw new Error('subscription_access_unavailable')
    // A teammate's run on a shared subscription: both must still be active members (workspace database).
    const runOwner = rows[0].runOwner
    if (typeof runOwner === 'string' && runOwner !== scope.ownerId) {
      try { await member(runOwner, String(rows[0].workspaceId)); await member(scope.ownerId, String(rows[0].workspaceId), runOwner) }
      catch (error) { throw new CodedError('subscription_access_unavailable', { detail: 'member_inactive', cause: error }) }
    }
    if (allowMissingProjection && row.state === 'connected' && (name === null || name === '')) throw new AccessProjectionMissing()
    if (typeof name !== 'string') throw new Error('subscription_access_unavailable')
    return name
  } finally { timingDone?.() }
}

type SnapshotDetail = 'request_invalid' | 'identity_failed' | 'fetch_failed' | 'http_refused' | 'body_too_large' | 'body_invalid' | 'secret_invalid'
const refused = (detail: SnapshotDetail | 'member_inactive', cause?: unknown) => new CodedError('subscription_access_unavailable', { detail, cause })

// The control plane reads exactly one authorized projection; the execution
// child gets no Infisical identity and cannot read other connections or grants.
export async function subscriptionAccessSnapshot(options: {
  origin: string; clientId: string; clientSecret: string; project: string
  environment: string; path: string; name: string; signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<{ name: string; value: string }> {
  let timingDone: (() => void) | undefined
  try {
    if (!/^mikka-byos-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.name) || !options.project || !options.environment || !options.path.startsWith('/')) throw refused('request_invalid')
    const fetcher = options.fetcher ?? fetch
    const token = await infisicalWorkloadToken(options.origin, options.clientId, options.clientSecret, options.signal, fetcher).catch(error => { throw refused('identity_failed', error) })
    const url = new URL(`/api/v4/secrets/${options.name}`, options.origin)
    for (const [key, value] of Object.entries({ projectId: options.project, environment: options.environment, secretPath: options.path, type: 'shared', version: '1', viewSecretValue: 'true', expandSecretReferences: 'false', includeImports: 'false' })) url.searchParams.set(key, value)
    timingDone = currentSubscriptionWorkerTiming()?.phase('parentProjectionRead')
    const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(options.signal ? [options.signal] : [])]) }).catch(error => { throw refused('fetch_failed', error) })
    if (!response.ok) throw refused('http_refused', { name: 'HttpStatus', code: response.status })
    const body = await response.text()
    if (Buffer.byteLength(body) > 262144) throw refused('body_too_large')
    let secret: { secretKey?: unknown; version?: unknown; secretValueHidden?: unknown; secretValue?: unknown } | undefined
    // error-cause: a JSON parse error quotes the body, which may hold the secret.
    try { secret = JSON.parse(body)?.secret } catch { throw refused('body_invalid') }
    if (secret?.secretKey !== options.name || secret.version !== 1 || secret.secretValueHidden || typeof secret.secretValue !== 'string' || !secret.secretValue || Buffer.byteLength(secret.secretValue) > 32768) throw refused('secret_invalid')
    return { name: options.name, value: secret.secretValue }
  } catch (error) {
    // The response body and the secret never reach the log or the error: only the detail and the cause's name and code.
    const refusal = error instanceof CodedError && error.code === 'subscription_access_unavailable' ? error : refused('fetch_failed', error)
    logCodedError(refusal)
    throw refusal
  } finally { timingDone?.() }
}
