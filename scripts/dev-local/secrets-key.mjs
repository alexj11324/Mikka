// WORKSPACE_SECRETS_KEY for pnpm dev:local when the developer set none: a random
// AES-256 key kept on this machine (git-ignored, mode 0600), so a workspace's own
// model key or E2B key saved in one run still opens in the next. It seals only
// the disposable local *_e2e database and is never a deployment's key.
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function localSecretsKey(directory) {
  const file = join(directory, 'workspace-secrets-key')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[a-f\d]{64}$/.test(existing)) return existing
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const key = randomBytes(32).toString('hex')
  writeFileSync(file, `${key}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return key
}
