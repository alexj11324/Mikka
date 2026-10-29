'use client'
import { createAuthClient } from 'better-auth/react'
import { multiSessionClient, twoFactorClient } from 'better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'
import { withBasePath } from '@/lib/base-path'
import { clearChatDrafts } from '@/lib/chat-drafts'
import { verifySecondFactor } from '@/lib/second-factor'
export { needsSecondFactor, secondFactorCodeKind } from '@/lib/second-factor'
export const authClient = createAuthClient({ basePath: withBasePath('/api/auth'), plugins: [multiSessionClient(), twoFactorClient(), passkeyClient()] })

/**
 * Every sign-out path goes through here, so nothing the session kept in this
 * tab (unsent chat drafts) outlives it.
 */
export async function endSession() {
  const result = await authClient.signOut()
  if (!result.error) clearChatDrafts()
  return result
}

/**
 * Sign-in step two: after authClient.signIn.email answers needsSecondFactor(data),
 * send the authenticator or backup code. The session cookie is set on success.
 */
export function finishSecondFactor(code: string, options?: { trustDevice?: boolean }) {
  return verifySecondFactor(authClient, code, options)
}

/** Passkey sign-in (WebAuthn prompt in the browser). */
export function signInWithPasskey() {
  return authClient.signIn.passkey()
}

/** Registers a passkey for the signed-in person (设置 › 安全 › 通行密钥). */
export function registerPasskey(name?: string) {
  return authClient.passkey.addPasskey(name ? { name } : undefined)
}
