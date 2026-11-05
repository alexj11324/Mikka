import { useEffect, useSyncExternalStore } from 'react'
import { clearChatDrafts } from '@/lib/chat-drafts'
import { clearPersistentReadCaches } from '@/lib/swr/persistent-cache'
import { rendererHost, type DesktopSession } from './host'

type AuthError = { code: string; status: number }
type SessionState = { data: DesktopSession | null; error: AuthError | null; isPending: boolean }
let state: SessionState = { data: null, error: null, isPending: true }
const listeners = new Set<() => void>()
let pending: Promise<{ data: DesktopSession | null; error: AuthError | null }> | null = null
let generation = 0
const subscribe = (changed: () => void) => { listeners.add(changed); return () => { listeners.delete(changed) } }
const snapshot = () => state

export function setSession(session: DesktopSession | null) {
  generation++
  pending = null
  state = { data: session, error: null, isPending: false }
  for (const listener of listeners) listener()
}

/** Read only the main process's sanitized session projection. */
async function getSession(_options?: { query?: { disableCookieCache?: boolean } }) {
  if (pending) return pending
  const current = generation
  const request = rendererHost().session()
    .then(session => {
      if (current !== generation) return { data: state.data, error: state.error }
      setSession(session)
      return { data: session, error: null }
    })
    .catch(() => {
      if (current !== generation) return { data: state.data, error: state.error }
      const error = { code: 'desktop_session_unavailable', status: 503 }
      // A connection error is not a sign-out. Keep a previously confirmed owner.
      state = { ...state, error, isPending: false }
      for (const listener of listeners) listener()
      return { data: null, error }
    })
    .finally(() => { if (pending === request) pending = null })
  pending = request
  return request
}

export const authClient = {
  getSession,
  useSession() {
    const current = useSyncExternalStore(subscribe, snapshot, snapshot)
    useEffect(() => { if (state.isPending) void getSession() }, [])
    return current
  },
  async signOut() {
    await rendererHost().signOut()
    setSession(null)
    return { data: { success: true }, error: null }
  },
  async listAccounts() {
    const data = await rendererHost().accounts()
    return { data, error: null }
  },
  async linkSocial({ provider }: { provider: 'google' | 'github'; callbackURL?: string; errorCallbackURL?: string }) {
    await rendererHost().linkAccount(provider)
    return { data: { url: undefined as string | undefined }, error: null }
  },
}

export async function endSession() {
  const result = await authClient.signOut()
  clearChatDrafts()
  await clearPersistentReadCaches()
  return result
}
