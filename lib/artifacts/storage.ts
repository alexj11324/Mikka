import 'server-only'
import { AwsClient } from 'aws4fetch'

// Artifact files in Cloudflare R2, through its S3 API. Each version is one
// immutable object. Without R2 settings (previews, tests) the file stays in
// the version row instead; production refuses to run that way.

interface R2Config { accountId: string; bucket: string; client: AwsClient }

function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  return { accountId, bucket: process.env.R2_ARTIFACTS_BUCKET ?? 'mikka-artifacts', client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }) }
}

/** Where files go: R2, or the database row when no bucket is configured outside production. */
export function artifactStorage(): 'r2' | 'inline' {
  if (r2Config()) return 'r2'
  if (process.env.VERCEL_ENV === 'production') throw new Error('R2 is not configured: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY')
  return 'inline'
}

function objectUrl(config: R2Config, key: string): string {
  return `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
}

export async function putArtifactObject(key: string, body: string | Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
  const config = r2Config()
  if (!config) throw new Error('R2 is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { method: 'PUT', body, headers: { 'content-type': contentType, 'if-none-match': '*' } })
  // 412: the object is already there; keys are content-addressed per version, so it is the same file.
  if (!response.ok && response.status !== 412) throw new Error(`R2 put failed: ${response.status}`)
}

export async function getArtifactObject(key: string): Promise<string> {
  const config = r2Config()
  if (!config) throw new Error('R2 is not configured')
  const response = await config.client.fetch(objectUrl(config, key))
  if (!response.ok) throw new Error(`R2 get failed: ${response.status}`)
  return response.text()
}

/** The object's bytes, for binary files such as run captures. */
export async function getArtifactObjectBytes(key: string): Promise<Uint8Array<ArrayBuffer>> {
  const config = r2Config()
  if (!config) throw new Error('R2 is not configured')
  const response = await config.client.fetch(objectUrl(config, key))
  if (!response.ok) throw new Error(`R2 get failed: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function deleteArtifactObject(key: string): Promise<void> {
  const config = r2Config()
  if (!config) throw new Error('R2 is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new Error(`R2 delete failed: ${response.status}`)
}

/**
 * A URL that lets its holder repeatedly PUT the same object key, with these
 * headers, for `seconds`. Callers must not expose this key as immutable
 * evidence: the holder can overwrite it until the signature expires.
 */
export async function presignArtifactPut(key: string, contentType: string, seconds: number): Promise<{ url: string; headers: Record<string, string> }> {
  const config = r2Config()
  if (!config) throw new Error('R2 is not configured')
  const url = new URL(objectUrl(config, key))
  url.searchParams.set('X-Amz-Expires', String(seconds))
  const headers = { 'content-type': contentType }
  const signed = await config.client.sign(url.toString(), { method: 'PUT', headers, aws: { signQuery: true, allHeaders: true } })
  return { url: signed.url, headers }
}
