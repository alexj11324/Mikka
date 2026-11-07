import { cloudEndpoint } from './config'
import { CloudServiceError, cloudErrorCode } from './errors'
import { cloudScopes, type CloudToken } from './types'

export async function readCloudJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new CloudServiceError('cloud_unavailable', 'protocol')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      size += part.value.length
      if (size > 64 * 1024) throw new CloudServiceError('cloud_unavailable', 'protocol')
      chunks.push(part.value)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudServiceError('cloud_unavailable', 'protocol')
    if (!response.ok) throw new CloudServiceError(cloudErrorCode(value.code) ?? cloudErrorCode(value.error) ?? 'cloud_unavailable', 'response')
    return value
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof CloudServiceError) throw error
    throw new CloudServiceError('cloud_unavailable', 'protocol', error)
  } finally { reader.releaseLock() }
}

/** No cookie, redirect or credential forwarding to a second origin. */
export async function cloudJson(serviceUrl: string, path: string, body: Record<string, unknown> | URLSearchParams, send: typeof fetch = fetch) {
  let response: Response
  try {
    response = await send(cloudEndpoint(serviceUrl, path), {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' },
      body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
    })
  } catch (error) { throw new CloudServiceError('cloud_unavailable', 'network', error) }
  return readCloudJson(response)
}

export function parseCloudToken(value: Record<string, unknown>, serverId: string, now = Date.now()): CloudToken {
  const scopes = cloudScopes(value.scope)
  if (value.token_type !== 'Bearer' || typeof value.access_token !== 'string' || value.access_token.length < 32 || value.access_token.length > 16_384
    || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 3600
    || value.server_id !== serverId || !scopes || typeof value.workspace_id !== 'string' || value.workspace_id.length > 128
    || typeof value.subject !== 'string' || value.subject.length > 256 || !['user', 'server_key'].includes(String(value.grant_type))
    || (value.grant_type === 'user' && (typeof value.refresh_token !== 'string' || value.refresh_token.length < 32 || value.refresh_token.length > 512))) {
    throw new CloudServiceError('cloud_unavailable', 'protocol')
  }
  return { accessToken: value.access_token, ...(value.grant_type === 'user' ? { refreshToken: value.refresh_token as string } : {}),
    expiresAt: now + value.expires_in * 1000, scopes, serverId, workspaceId: value.workspace_id, subject: value.subject, grantType: value.grant_type as CloudToken['grantType'] }
}
