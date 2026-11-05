import { mkdir, open, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { BundledSession } from '@mikka/protocol/bridge'

export interface EncryptedStorage {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

export interface StoredSession { token: string; identity: BundledSession; workspace?: string }

export const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function publicSession(value: unknown): BundledSession | null {
  if (!value || typeof value !== 'object') return null
  const { user, session } = value as { user?: Record<string, unknown>; session?: Record<string, unknown> }
  if (!user || !session || typeof session.id !== 'string' || session.id.length > 200 || !session.id || typeof user.id !== 'string' || user.id.length > 200 || !user.id || typeof user.email !== 'string' || user.email.length > 320 || typeof user.name !== 'string' || user.name.length > 500) return null
  return { user: { id: user.id, email: user.email, name: user.name, image: typeof user.image === 'string' && user.image.length <= 2048 ? user.image : null }, session: { id: session.id } }
}

export function storedSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { token?: unknown; identity?: unknown; workspace?: unknown }
  const identity = publicSession(candidate.identity)
  return identity && typeof candidate.token === 'string' && candidate.token.length >= 16 && candidate.token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(candidate.token)
    ? { identity, token: candidate.token, ...(typeof candidate.workspace === 'string' && WORKSPACE_ID.test(candidate.workspace) ? { workspace: candidate.workspace } : {}) } : null
}

/** The file contains only OS-keychain ciphertext and is scoped to the backend.
 * No plaintext/basic_text fallback; an unavailable keychain fails sign-in closed. */
export class SessionVault {
  private readonly path: string
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string, private readonly server: string, private readonly encryption: EncryptedStorage) {
    this.path = join(directory, 'desktop-session.bin')
  }
  async load(): Promise<StoredSession | null> {
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if ((await file.stat()).size > 64 * 1024 || !await this.encryption.available()) return null
        const parsed = JSON.parse(await this.encryption.decrypt(await file.readFile())) as { version?: unknown; server?: unknown; value?: unknown }
        return parsed.version === 1 && parsed.server === this.server ? storedSession(parsed.value) : null
      } finally { await file.close() }
    } catch { return null }
  }
  save(value: StoredSession | null): Promise<void> {
    const run = this.pending.then(async () => {
      if (!value) { await rm(this.path, { force: true }); return }
      if (!storedSession(value) || !await this.encryption.available()) throw new Error('Secure session storage unavailable / 安全会话存储不可用')
      const ciphertext = await this.encryption.encrypt(JSON.stringify({ version: 1, server: this.server, value }))
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.tmp`
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(ciphertext); await file.sync() } finally { await file.close() }
      await rename(temporary, this.path)
    })
    this.pending = run.catch(() => {})
    return run
  }
}
