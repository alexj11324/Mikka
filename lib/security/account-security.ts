// 设置 › 个人 › 安全: two-step verification (TOTP + backup codes) and passkeys.
// The better-auth plugins own the secrets; this module adds Mikka's rules
// (validation, error codes, audit) over their server API so it can be tested
// with a fake API or a real better-auth instance.
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionErrorCode } from '@/lib/action-result'
import type { AuditAction } from '@/lib/audit/actions'

type Body = Record<string, unknown>
type ApiCall<R = unknown> = (input: { body?: Body; headers: Headers }) => Promise<R>

export interface SecurityAuthApi {
  enableTwoFactor: ApiCall<{ totpURI?: string; backupCodes?: string[] }>
  verifyTOTP: ApiCall
  verifyBackupCode: ApiCall
  disableTwoFactor: ApiCall
  generateBackupCodes: ApiCall<{ backupCodes: string[] }>
  updatePasskey: ApiCall
  deletePasskey: ApiCall
}

export interface PasskeyRow {
  id: string
  name: string | null
  aaguid: string | null
  deviceType: string
  backedUp: boolean
  createdAt: Date | null
  lastUsedAt: Date | null
}

export interface SecurityStore {
  twoFactorState(userId: string): Promise<{ enabled: boolean; pending: boolean; backupCodesRemaining: number | null }>
  hasPassword(userId: string): Promise<boolean>
  /** Turns two-step verification off after the person proved a code (no password needed). */
  clearTwoFactor(userId: string): Promise<void>
  listPasskeys(userId: string): Promise<PasskeyRow[]>
  passkeyOwner(passkeyId: string): Promise<string | null>
}

export interface AccountSecurityDeps {
  api: SecurityAuthApi
  store: SecurityStore
  headers: () => Promise<Headers>
  audit: (actorId: string, action: AuditAction, target?: string | null) => Promise<void>
  authenticatorName?: (aaguid: string | null) => string | undefined
}

const password = z.string().min(1).max(256)
const totpCode = z.string().trim().regex(/^\d{6}$/)
const anyCode = z.string().trim().min(6).max(32)
const passkeyId = z.string().min(1).max(200)
const passkeyName = z.string().trim().min(1).max(64)

function apiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const body = (error as { body?: { code?: unknown } }).body
  return typeof body?.code === 'string' ? body.code : null
}

const API_ERRORS: Record<string, ActionErrorCode> = {
  INVALID_PASSWORD: 'securityPasswordInvalid',
  INVALID_CODE: 'twoFactorCodeInvalid',
  INVALID_BACKUP_CODE: 'twoFactorCodeInvalid',
  TOTP_ALREADY_ENABLED: 'twoFactorAlreadyEnabled',
  TOTP_NOT_ENABLED: 'twoFactorNotEnabled',
  TWO_FACTOR_NOT_ENABLED: 'twoFactorNotEnabled',
  SESSION_NOT_FRESH: 'securityReauthRequired',
  PASSKEY_NOT_FOUND: 'passkeyNotFound',
  YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: 'passkeyNotFound',
}

/** Turns a better-auth APIError into an action error; anything else keeps propagating. */
async function call<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn()
  } catch (error) {
    const code = apiErrorCode(error)
    if (code && API_ERRORS[code]) throw new ActionFailureError(API_ERRORS[code])
    if (code === 'UNAUTHORIZED' || (error as { status?: unknown })?.status === 'UNAUTHORIZED') throw new ActionFailureError('authRequired')
    throw error
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ActionFailureError('validationGeneric')
  return result.data
}

export interface SecurityOverview {
  twoFactor: { enabled: boolean; pending: boolean; backupCodesRemaining: number | null; passwordRequired: boolean }
  passkeys: { id: string; name: string; createdAt: string | null; lastUsedAt: string | null; deviceType: string; backedUp: boolean }[]
}

export function createAccountSecurity(deps: AccountSecurityDeps) {
  async function requirePasswordIfAny(userId: string, value: unknown) {
    if (!await deps.store.hasPassword(userId)) return undefined
    if (value === undefined || value === null || value === '') throw new ActionFailureError('securityPasswordRequired')
    return parse(password, value)
  }

  return {
    async overview(userId: string): Promise<SecurityOverview> {
      const [state, hasPassword, passkeys] = await Promise.all([
        deps.store.twoFactorState(userId), deps.store.hasPassword(userId), deps.store.listPasskeys(userId),
      ])
      return {
        twoFactor: { ...state, passwordRequired: hasPassword },
        passkeys: passkeys.map(row => ({
          id: row.id,
          name: row.name || deps.authenticatorName?.(row.aaguid) || 'Passkey',
          createdAt: row.createdAt?.toISOString() ?? null,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          deviceType: row.deviceType,
          backedUp: row.backedUp,
        })),
      }
    },

    /**
     * Step one: a new secret and backup codes. Nothing is enforced until
     * confirmTwoFactor() checks one code from the authenticator app.
     */
    async startTwoFactor(userId: string, input: { password?: string }): Promise<{ totpURI: string; backupCodes: string[] }> {
      const state = await deps.store.twoFactorState(userId)
      if (state.enabled) throw new ActionFailureError('twoFactorAlreadyEnabled')
      const pass = await requirePasswordIfAny(userId, input.password)
      const result = await call(async () => deps.api.enableTwoFactor({ body: { ...(pass ? { password: pass } : {}) }, headers: await deps.headers() }))
      if (!result.totpURI || !result.backupCodes) throw new ActionFailureError('generic')
      return { totpURI: result.totpURI, backupCodes: result.backupCodes }
    },

    async confirmTwoFactor(userId: string, input: { code: string }): Promise<{ enabled: true }> {
      const code = parse(totpCode, input.code)
      const state = await deps.store.twoFactorState(userId)
      if (state.enabled) throw new ActionFailureError('twoFactorAlreadyEnabled')
      if (!state.pending) throw new ActionFailureError('twoFactorNotEnabled')
      await call(async () => deps.api.verifyTOTP({ body: { code }, headers: await deps.headers() }))
      await deps.audit(userId, 'two_factor.enabled')
      return { enabled: true }
    },

    /** Off with the current password, or with an authenticator / backup code. */
    async disableTwoFactor(userId: string, input: { password?: string; code?: string }): Promise<{ enabled: false }> {
      const state = await deps.store.twoFactorState(userId)
      if (!state.enabled && !state.pending) throw new ActionFailureError('twoFactorNotEnabled')
      if (input.code) {
        const code = parse(anyCode, input.code)
        if (!state.enabled) throw new ActionFailureError('twoFactorNotEnabled')
        const verify = /^\d{6}$/.test(code) ? deps.api.verifyTOTP : deps.api.verifyBackupCode
        await call(async () => verify({ body: { code }, headers: await deps.headers() }))
        await deps.store.clearTwoFactor(userId)
      } else {
        const pass = await requirePasswordIfAny(userId, input.password)
        await call(async () => deps.api.disableTwoFactor({ body: { ...(pass ? { password: pass } : {}) }, headers: await deps.headers() }))
      }
      if (state.enabled) await deps.audit(userId, 'two_factor.disabled')
      return { enabled: false }
    },

    /** New backup codes replace the old ones; the plain codes exist only in this response. */
    async regenerateBackupCodes(userId: string, input: { password?: string }): Promise<{ backupCodes: string[] }> {
      const state = await deps.store.twoFactorState(userId)
      if (!state.enabled) throw new ActionFailureError('twoFactorNotEnabled')
      const pass = await requirePasswordIfAny(userId, input.password)
      const result = await call(async () => deps.api.generateBackupCodes({ body: { ...(pass ? { password: pass } : {}) }, headers: await deps.headers() }))
      await deps.audit(userId, 'two_factor.backup_codes_regenerated')
      return { backupCodes: result.backupCodes }
    },

    async renamePasskey(userId: string, input: { id: string; name: string }): Promise<{ id: string; name: string }> {
      const id = parse(passkeyId, input.id)
      const name = parse(passkeyName, input.name)
      if (await deps.store.passkeyOwner(id) !== userId) throw new ActionFailureError('passkeyNotFound')
      await call(async () => deps.api.updatePasskey({ body: { id, name }, headers: await deps.headers() }))
      await deps.audit(userId, 'passkey.renamed', name)
      return { id, name }
    },

    async deletePasskey(userId: string, input: { id: string }): Promise<{ id: string }> {
      const id = parse(passkeyId, input.id)
      if (await deps.store.passkeyOwner(id) !== userId) throw new ActionFailureError('passkeyNotFound')
      await call(async () => deps.api.deletePasskey({ body: { id }, headers: await deps.headers() }))
      await deps.audit(userId, 'passkey.deleted', id)
      return { id }
    },
  }
}

export type AccountSecurity = ReturnType<typeof createAccountSecurity>
