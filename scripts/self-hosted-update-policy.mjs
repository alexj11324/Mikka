import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'

export const UPSTREAM_REPOSITORY = 'alexj11324/Mikka'
export const IMAGE_REPOSITORY = 'ghcr.io/alexj11324/mikka'
export const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const RELEASE_MARKER = /<!-- mikka-self-hosted-release-v2 sha=([0-9a-f]{40}) digest=(sha256:[0-9a-f]{64}) migrations=([0-9a-f]{64}) protocol=0-1 -->/

export function parseStableRelease(release) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease ||
    typeof release.tag_name !== 'string' || !STABLE_TAG.test(release.tag_name)) {
    throw new Error('SELF_HOSTED_UPDATE_RELEASE_NOT_STABLE')
  }
  const match = typeof release.body === 'string' ? release.body.match(RELEASE_MARKER) : null
  if (!match) throw new Error('SELF_HOSTED_UPDATE_RELEASE_UNVERIFIED')
  return { tag: release.tag_name, revision: match[1], migrations: match[3], image: assertPinnedImage(IMAGE_REPOSITORY + '@' + match[2]) }
}

/** A signed old webhook must not downgrade a server after a newer release. */
export function compareStableTags(a, b) {
  if (!STABLE_TAG.test(a || '') || !STABLE_TAG.test(b || '')) throw new Error('SELF_HOSTED_UPDATE_RELEASE_NOT_STABLE')
  const left = a.slice(1).split('.').map(BigInt)
  const right = b.slice(1).split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}

export function verifySignature(bytes, signature, secret) {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(signature || '')) return false
  const sent = Buffer.from(signature.slice(7), 'hex')
  const actual = createHmac('sha256', secret).update(bytes).digest()
  return timingSafeEqual(sent, actual)
}

export function releaseFromWebhook(bytes, headers, secret) {
  if (!verifySignature(bytes, headers['x-hub-signature-256'], secret)) {
    throw new Error('SELF_HOSTED_UPDATE_WEBHOOK_UNAUTHORIZED')
  }
  if (headers['x-github-event'] !== 'release') return null
  let payload
  try { payload = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error('SELF_HOSTED_UPDATE_WEBHOOK_INVALID') }
  if (payload.repository?.full_name !== UPSTREAM_REPOSITORY || payload.action !== 'published') return null
  if (!payload.release || payload.release.draft || payload.release.prerelease ||
    !STABLE_TAG.test(payload.release.tag_name || '')) return null
  return parseStableRelease(payload.release)
}

/** Every SQL/metadata migration file is part of the compatibility fingerprint.
 * This is an inventory hash, not proof that arbitrary migrations are reversible. */
export function migrationsFingerprint(directory = 'drizzle') {
  const files = []
  const walk = root => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  walk(directory)
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(relative(directory, file).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function assessUpgrade(current, release, { unattended = false, allowMigrations = false, idleGuard = false, drainHook = false, backupHook = false } = {}) {
  if (!current || !/^[0-9a-f]{40}$/.test(current.revision || '')) throw new Error('SELF_HOSTED_UPDATE_INSTALLED_REVISION_UNKNOWN')
  if (current.revision === release.revision) return { action: 'already-current', migrationChanged: false }
  if (unattended && (!idleGuard || !drainHook)) throw new Error('SELF_HOSTED_UPDATE_DRAIN_REQUIRED')
  if (current.migrations !== release.migrations) {
    if (unattended || !allowMigrations) throw new Error('SELF_HOSTED_UPDATE_MIGRATION_REVIEW_REQUIRED')
    if (!backupHook) throw new Error('SELF_HOSTED_UPDATE_BACKUP_REQUIRED')
  }
  return { action: 'upgrade', migrationChanged: current.migrations !== release.migrations }
}

export function assertPinnedImage(image) {
  if (typeof image !== 'string' || !/^ghcr\.io\/alexj11324\/mikka@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('SELF_HOSTED_UPDATE_IMAGE_NOT_PINNED')
  }
  return image
}

export function ensureRegularEnvFile(path) {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('SELF_HOSTED_UPDATE_ENV_NOT_REGULAR')
}

if (process.argv[1] && process.argv[1].endsWith('/self-hosted-update-policy.mjs') && process.argv[2] === 'migrations-hash') {
  console.log(migrationsFingerprint())
}
