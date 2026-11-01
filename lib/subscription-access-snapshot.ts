import 'server-only'
import { runMayUseCredentialSql } from './personal-policy'
import { infisicalWorkloadToken } from './infisical-workload'
import type { Pool } from 'pg'
import type { CredentialScope } from '../packages/daemon/src/subscription-worker-client'

export async function authorizedAccessName(database: Pick<Pool, 'query'>, scope: CredentialScope, use: { bindingId: string; consumerId: string; runId?: string }, revision: unknown): Promise<string> {
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error('subscription_access_unavailable')
  const { rows } = await database.query(`select c."accessSecretName" from byos_connections c join byos_bindings b on b."connectionId"=c.id where c.id=$1 and c."ownerId"=$2 and c."workspaceId"=$3 and c.provider=$4 and c.epoch=$5 and c.state in ('connected','refreshing','publication_pending') and b.id=$6 and b."ownerId"=$2 and b."consumerId"=$7 and b."connectionRevision"=$5 and ($8::uuid is null or exists(select 1 from agent_runs r join byos_native_runs n on n."runId"=r.id where r.id=$8 and ${runMayUseCredentialSql('$2', 'r."userId"', 'b."workspaceId"')} and r."agentId"::text=$7 and n."bindingId"=b.id and r.status in ('preparing','running','paused','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null))`, [scope.connectionId, scope.ownerId, scope.workspaceId, scope.provider, revision, use.bindingId, use.consumerId, use.runId ?? null])
  const name = rows[0]?.accessSecretName
  if (typeof name !== 'string') throw new Error('subscription_access_unavailable')
  return name
}

// The control plane reads exactly one authorized projection; the execution
// child gets no Infisical identity and cannot read other connections or grants.
export async function subscriptionAccessSnapshot(options: {
  origin: string; clientId: string; clientSecret: string; project: string
  environment: string; path: string; name: string; signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<{ name: string; value: string }> {
  try {
    if (!/^mikka-byos-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.name) || !options.project || !options.environment || !options.path.startsWith('/')) throw new Error()
    const fetcher = options.fetcher ?? fetch
    const token = await infisicalWorkloadToken(options.origin, options.clientId, options.clientSecret, options.signal, fetcher)
    const url = new URL(`/api/v4/secrets/${options.name}`, options.origin)
    for (const [key, value] of Object.entries({ projectId: options.project, environment: options.environment, secretPath: options.path, type: 'shared', version: '1', viewSecretValue: 'true', expandSecretReferences: 'false', includeImports: 'false' })) url.searchParams.set(key, value)
    const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(options.signal ? [options.signal] : [])]) })
    if (!response.ok) throw new Error()
    const body = await response.text()
    if (Buffer.byteLength(body) > 262144) throw new Error()
    const secret = JSON.parse(body)?.secret
    if (secret?.secretKey !== options.name || secret.version !== 1 || secret.secretValueHidden || typeof secret.secretValue !== 'string' || !secret.secretValue || Buffer.byteLength(secret.secretValue) > 32768) throw new Error()
    return { name: options.name, value: secret.secretValue }
  } catch {
    throw new Error('subscription_access_unavailable')
  }
}
