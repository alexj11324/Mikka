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
export interface StoredAccounts { activeUserId: string | null; accounts: StoredSession[] }
export const MAX_STORED_ACCOUNTS = 5

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
  // oxlint-disable-next-line no-control-regex -- Credentials cannot contain header separators or control bytes.
  return identity && typeof candidate.token === 'string' && candidate.token.length >= 16 && candidate.token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(candidate.token)
    ? { identity, token: candidate.token, ...(typeof candidate.workspace === 'string' && WORKSPACE_ID.test(candidate.workspace) ? { workspace: candidate.workspace } : {}) } : null
}

/** All retained identities are main-process data. Reject a malformed account
 * set as a whole, so duplicate users or an unknown active ID cannot select a
 * token under another person's public identity. */
export function storedAccounts(value: unknown): StoredAccounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { activeUserId?: unknown; accounts?: unknown }
  if (candidate.activeUserId !== null && (typeof candidate.activeUserId !== 'string' || !candidate.activeUserId || candidate.activeUserId.length > 200)) return null
  if (!Array.isArray(candidate.accounts) || candidate.accounts.length > MAX_STORED_ACCOUNTS) return null
  const accounts: StoredSession[] = []
  const ids = new Set<string>()
  for (const raw of candidate.accounts) {
    const account = storedSession(raw)
    if (!account || ids.has(account.identity.user.id)) return null
    ids.add(account.identity.user.id)
    accounts.push(account)
  }
  if (candidate.activeUserId !== null && !ids.has(candidate.activeUserId)) return null
  return { activeUserId: candidate.activeUserId, accounts }
}

/** The file contains only OS-keychain ciphertext and is scoped to the backend.
 * No plaintext/basic_text fallback; an unavailable keychain fails sign-in closed. */
export class SessionVault {
  private readonly path: string
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string, private readonly server: string, private readonly encryption: EncryptedStorage) {
    this.path = join(directory, 'desktop-session.bin')
  }
  async ensureAvailable(): Promise<void> {
    if (!await this.encryption.available()) throw new Error('Secure session storage unavailable / 安全会话存储不可用')
  }
  async load(): Promise<StoredSession | null> {
    const saved = await this.loadAccounts()
    return saved?.accounts.find(account => account.identity.user.id === saved.activeUserId) ?? null
  }
  save(value: StoredSession | null): Promise<void> {
    if (value === null) return this.saveAccounts(null)
    const checked = storedSession(value)
    if (!checked) return Promise.reject(new Error('Invalid desktop session'))
    return this.saveAccounts({ activeUserId: checked.identity.user.id, accounts: [checked] })
  }
  loadAccounts(): Promise<StoredAccounts | null> {
    return this.serial(async () => {
      try {
        const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        let value: StoredAccounts | null = null
        let migrate = false
        try {
          if ((await file.stat()).size > 64 * 1024 || !await this.encryption.available()) return null
          const parsed = JSON.parse(await this.encryption.decrypt(await file.readFile())) as { version?: unknown; server?: unknown; value?: unknown }
          if (parsed.server !== this.server) return null
          if (parsed.version === 2) value = storedAccounts(parsed.value)
          else if (parsed.version === 1) {
            const legacy = storedSession(parsed.value)
            if (legacy) { value = { activeUserId: legacy.identity.user.id, accounts: [legacy] }; migrate = true }
          }
        } finally { await file.close() }
        // Migration shares the write queue so it cannot overwrite a newer sign-in.
        if (migrate && value) await this.persist(value)
        return value
      } catch { return null }
    })
  }
  saveAccounts(value: StoredAccounts | null): Promise<void> {
    // Snapshot before queuing: caller mutations cannot alter pending ciphertext.
    const checked = value === null ? null : storedAccounts(value)
    if (value !== null && !checked) return Promise.reject(new Error('Invalid desktop accounts'))
    return this.serial(() => this.persist(checked))
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.then(work)
    this.pending = run.then(() => {}, () => {})
    return run
  }
  private async persist(value: StoredAccounts | null): Promise<void> {
    if (!value || !value.accounts.length) { await rm(this.path, { force: true }); return }
    await this.ensureAvailable()
    const ciphertext = await this.encryption.encrypt(JSON.stringify({ version: 2, server: this.server, value }))
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(ciphertext); await file.sync() } finally { await file.close() }
    await rename(temporary, this.path)
  }
}
