import { AsyncLocalStorage } from 'node:async_hooks'
import type { DesktopSession } from './wire'

/** Installed only after a fresh bearer check; never derived from renderer data. */
const desktopSession = new AsyncLocalStorage<unknown>()
export function withDesktopSession<T>(session: unknown, work: () => T): T { return desktopSession.run(session, work) }
export function currentDesktopSession(): unknown { return desktopSession.getStore() }
export function desktopHumanSessionId(): string | undefined { return (desktopSession.getStore() as { session: { id: string } } | undefined)?.session.id }

export function safeDesktopSession(value: {
  user: { id: string; name: string; email: string; image?: string | null; emailVerified: boolean }
  session: { id: string }
}): DesktopSession {
  return {
    user: { id: value.user.id, name: value.user.name, email: value.user.email, image: value.user.image ?? null, emailVerified: value.user.emailVerified },
    session: { id: value.session.id },
  }
}
