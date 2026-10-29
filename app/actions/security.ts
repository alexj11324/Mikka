'use server'

// 设置 › 个人 › 安全 (docs/settings-backend/security.md). Passkey registration
// itself runs in the browser: registerPasskey() in lib/auth-client.ts.
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { getSession } from '@/lib/session'
import { accountSecurity } from '@/lib/security/account-security-runtime'
import type { SecurityOverview } from '@/lib/security/account-security'

/**
 * The signed-in browser session only: these call better-auth with the request's
 * cookies, so an MCP/acting-user context (lib/acting-user.ts) never applies.
 */
async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user
}

export async function getSecurityOverview(): Promise<ActionResult<SecurityOverview>> {
  return runAction(async () => accountSecurity.overview((await requireUser()).id))
}

export async function startTwoFactorSetup(input: { password?: string } = {}): Promise<ActionResult<{ totpURI: string; backupCodes: string[] }>> {
  return runAction(async () => accountSecurity.startTwoFactor((await requireUser()).id, input))
}

export async function confirmTwoFactorSetup(input: { code: string }): Promise<ActionResult<{ enabled: true }>> {
  return runAction(async () => accountSecurity.confirmTwoFactor((await requireUser()).id, input))
}

export async function disableTwoFactor(input: { password?: string; code?: string }): Promise<ActionResult<{ enabled: false }>> {
  return runAction(async () => accountSecurity.disableTwoFactor((await requireUser()).id, input))
}

export async function regenerateBackupCodes(input: { password?: string } = {}): Promise<ActionResult<{ backupCodes: string[] }>> {
  return runAction(async () => accountSecurity.regenerateBackupCodes((await requireUser()).id, input))
}

export async function renamePasskey(input: { id: string; name: string }): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(async () => accountSecurity.renamePasskey((await requireUser()).id, input))
}

export async function deletePasskey(input: { id: string }): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => accountSecurity.deletePasskey((await requireUser()).id, input))
}
