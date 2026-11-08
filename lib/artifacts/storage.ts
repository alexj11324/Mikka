import 'server-only'
import { AwsClient } from 'aws4fetch'
import { isCloudEdition } from '@/lib/edition'

// Artifact files use an administrator-owned S3-compatible bucket (including R2).
// Each version is immutable. Community installations without a bucket retain
// the bytes in their database; hosted production still requires object storage.

interface ObjectStorageConfig { endpoint: string; bucket: string; client: AwsClient }

function objectStorageConfig(): ObjectStorageConfig | null {
  const endpoint = process.env.S3_ENDPOINT?.trim()
  if (endpoint || process.env.S3_BUCKET || process.env.S3_ACCESS_KEY_ID || process.env.S3_SECRET_ACCESS_KEY) {
    const bucket = process.env.S3_BUCKET?.trim(), accessKeyId = process.env.S3_ACCESS_KEY_ID, secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 configuration is incomplete')
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\\/]/.test(bucket)) throw new Error('S3 configuration is invalid')
    return { endpoint: url.href.replace(/\/+$/, ''), bucket, client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: process.env.S3_REGION?.trim() || 'us-east-1' }) }
  }
  const accountId = process.env.R2_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  return { endpoint: `https://${accountId}.r2.cloudflarestorage.com`, bucket: process.env.R2_ARTIFACTS_BUCKET ?? 'mikka-artifacts', client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }) }
}

/** Where files go: R2, or the database row when no bucket is configured outside production. */
export function artifactStorage(): 'r2' | 'inline' {
  // Keep the existing persisted 'r2' discriminator for every S3 transport.
  if (objectStorageConfig()) return 'r2'
  if (isCloudEdition() && process.env.VERCEL_ENV === 'production') throw new Error('Object storage is not configured')
  return 'inline'
}

function objectUrl(config: ObjectStorageConfig, key: string): string {
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/** aws4fetch's retry backoff does not observe AbortSignal. Deadline-bound
 * writes sign once and let fetch abort the actual request without late retries. */
async function writeObject(config: ObjectStorageConfig, key: string, init: RequestInit, signal?: AbortSignal) {
  if (!signal) return config.client.fetch(objectUrl(config, key), init)
  signal.throwIfAborted()
  const signed = await config.client.sign(objectUrl(config, key), { ...init, signal })
  signal.throwIfAborted()
  return fetch(signed, { signal })
}

export async function putArtifactObject(key: string, body: string | Uint8Array<ArrayBuffer>, contentType: string, signal?: AbortSignal): Promise<void> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  // Next's fetch adapter can stream a signed Request and lose its implicit
  // body length. R2 rejects that transfer with 411, so carry the byte length.
  const contentLength = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength
  const response = await writeObject(config, key, { method: 'PUT', body, redirect: 'error', headers: { 'content-type': contentType, 'content-length': String(contentLength), 'if-none-match': '*' } }, signal)
  // 412: the object is already there; keys are content-addressed per version, so it is the same file.
  if (!response.ok && response.status !== 412) throw new Error(`Object storage put failed: ${response.status}`)
}

export async function getArtifactObject(key: string): Promise<string> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { redirect: 'error' })
  if (!response.ok) throw new Error(`Object storage get failed: ${response.status}`)
  return response.text()
}

/** Stream an existing immutable object without buffering a recording in the server. */
export async function getArtifactObjectStream(key: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { signal, redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`Object storage get failed: ${response.status}`)
  return response.body
}

/** The object's bytes, for binary files such as run captures. */
export async function getArtifactObjectBytes(key: string): Promise<Uint8Array<ArrayBuffer>> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { redirect: 'error' })
  if (!response.ok) throw new Error(`Object storage get failed: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function deleteArtifactObject(key: string, signal?: AbortSignal): Promise<void> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await writeObject(config, key, { method: 'DELETE', redirect: 'error' }, signal)
  if (!response.ok && response.status !== 404) throw new Error(`Object storage delete failed: ${response.status}`)
}

/**
 * A URL that lets its holder repeatedly PUT the same object key, with these
 * headers, for `seconds`. Callers must not expose this key as immutable
 * evidence: the holder can overwrite it until the signature expires.
 */
export async function presignArtifactPut(key: string, contentType: string, seconds: number): Promise<{ url: string; headers: Record<string, string> }> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const url = new URL(objectUrl(config, key))
  url.searchParams.set('X-Amz-Expires', String(seconds))
  const headers = { 'content-type': contentType }
  const signed = await config.client.sign(url.toString(), { method: 'PUT', headers, aws: { signQuery: true, allHeaders: true } })
  return { url: signed.url, headers }
}

/** Short-lived private download; large originals bypass the function response-body limit. */
export async function presignArtifactGet(key: string, contentType: string, disposition: string, seconds = 60): Promise<string> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const url = new URL(objectUrl(config, key))
  url.searchParams.set('X-Amz-Expires', String(seconds))
  url.searchParams.set('response-content-type', contentType)
  url.searchParams.set('response-content-disposition', disposition)
  return (await config.client.sign(url.toString(), { method: 'GET', aws: { signQuery: true, allHeaders: true } })).url
}
