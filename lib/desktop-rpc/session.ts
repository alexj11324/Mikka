import { AsyncLocalStorage } from 'node:async_hooks'
import type { DesktopSession } from './wire'

/** Installed only after a fresh bearer check; never derived from renderer data. */
const desktopSession = new AsyncLocalStorage<{ session: unknown; rotatedToken?: string }>()
const desktopLocale = new AsyncLocalStorage<'en' | 'zh-CN'>()
export function withDesktopSession<T>(session: unknown, work: () => T): T { return desktopSession.run({ session }, work) }
export function currentDesktopSession(): unknown { return desktopSession.getStore()?.session }
export function desktopHumanSessionId(): string | undefined { return (currentDesktopSession() as { session: { id: string } } | undefined)?.session.id }
export function recordDesktopTokenRotation(token: string): void {
  const scope = desktopSession.getStore()
  if (scope) scope.rotatedToken = token
}
export function desktopRotatedToken(): string | undefined { return desktopSession.getStore()?.rotatedToken }
export function withDesktopLocale<T>(locale: 'en' | 'zh-CN', work: () => T): T { return desktopLocale.run(locale, work) }
export function currentDesktopLocale(): 'en' | 'zh-CN' | undefined { return desktopLocale.getStore() }

export function safeDesktopSession(value: {
  user: { id: string; name: string; email: string; image?: string | null; emailVerified: boolean }
  session: { id: string }
}): DesktopSession {
  return {
    user: { id: value.user.id, name: value.user.name, email: value.user.email, image: value.user.image ?? null, emailVerified: value.user.emailVerified },
    session: { id: value.session.id },
  }
}
