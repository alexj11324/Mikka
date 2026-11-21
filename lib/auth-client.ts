'use client'
import { createAuthClient } from 'better-auth/react'
import { multiSessionClient } from 'better-auth/client/plugins'
import { useEffect, useSyncExternalStore } from 'react'
import { withBasePath } from '@/lib/base-path'
import { clearChatDrafts } from '@/lib/chat-drafts'
import { clearPersistentReadCaches } from '@/lib/swr/persistent-cache'
import { currentWebServers, subscribeWebServers, webServerSnapshot } from '@/lib/web-connection/browser'
export const cloudAuthClient = createAuthClient({ basePath: withBasePath('/api/auth'), plugins: [multiSessionClient()] })

async function getServerSession(...args: Parameters<typeof cloudAuthClient.getSession>) {
  const servers = currentWebServers()
  if (!servers || (!servers.getActiveAccount() && !servers.getSnapshot().expiredServer)) return cloudAuthClient.getSession(...args)
  try { return { data: await servers.readSession(), error: null } }
  catch (cause) { return { data: null, error: { code: 'web_connection_session_unavailable', message: 'web_connection_session_unavailable', status: 503, statusText: 'Service Unavailable', cause } } }
}
function useServerSession(...args: Parameters<typeof cloudAuthClient.useSession>) {
  const cloud = cloudAuthClient.useSession(...args)
  const remote = useSyncExternalStore(subscribeWebServers, webServerSnapshot, webServerSnapshot)
  useEffect(() => {
    if (cloud.data?.user.id) void currentWebServers()?.rememberCloudAccounts([cloud.data.user.id])
  }, [cloud.data?.user.id])
  // This is an application projection only. Never fabricate or write a remote
  // credential into Better Auth's official-cloud cookie/session atom.
  return remote.account || remote.expiredServer ? { ...cloud, data: remote.account, error: null, isPending: false, isRefetching: false,
    refetch: () => getServerSession() } : cloud
}
async function signOutServer(...args: Parameters<typeof cloudAuthClient.signOut>) {
  const servers = currentWebServers()
  if (!servers || (!servers.getActiveAccount() && !servers.getSnapshot().expiredServer)) {
    // A handoff already in flight must not sign back in after a cloud logout.
    await servers?.switchServer(null)
    return cloudAuthClient.signOut(...args)
  }
  try { await servers.signOut(); return { data: { success: true }, error: null } }
  catch { return { data: null, error: { code: 'web_connection_revoke_unconfirmed', status: 503, statusText: 'Service Unavailable' } } }
}
export const authClient = new Proxy(cloudAuthClient, { get(target, key, receiver) {
  if (key === 'getSession') return getServerSession
  if (key === 'useSession') return useServerSession
  if (key === 'signOut') return signOutServer
  return Reflect.get(target, key, receiver)
} }) as Omit<typeof cloudAuthClient, 'getSession' | 'useSession' | 'signOut'> & {
  getSession: typeof getServerSession; useSession: typeof useServerSession; signOut: typeof signOutServer
}

/**
 * Every sign-out path goes through here, so nothing the session kept in this
 * tab (unsent chat drafts) outlives it.
 */
export async function endSession() {
  const result = await authClient.signOut()
  if (!result.error) { clearChatDrafts(); await clearPersistentReadCaches() }
  return result
}
