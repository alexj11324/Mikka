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

export async function putArtifactObject(key: string, body: string, contentType: string): Promise<void> {
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
