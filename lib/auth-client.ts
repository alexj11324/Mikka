'use client'
import { createAuthClient } from 'better-auth/react'
import { multiSessionClient } from 'better-auth/client/plugins'
import { withBasePath } from '@/lib/base-path'
import { clearChatDrafts } from '@/lib/chat-drafts'
export const authClient = createAuthClient({ basePath: withBasePath('/api/auth'), plugins: [multiSessionClient()] })

/**
 * Every sign-out path goes through here, so nothing the session kept in this
 * tab (unsent chat drafts) outlives it.
 */
export async function endSession() {
  const result = await authClient.signOut()
  if (!result.error) clearChatDrafts()
  return result
}
