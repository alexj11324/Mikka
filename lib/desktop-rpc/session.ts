import { AsyncLocalStorage } from 'node:async_hooks'
import type { DesktopSession } from './wire'

/** Installed only after Better Auth verifies the bearer (and optional signed
 * read cache). A sensitive action upgrades the request to a database identity. */
type DesktopIdentity = { session: unknown; fresh: boolean; refresh?: () => Promise<unknown>; refreshing?: Promise<unknown>; rotatedToken?: string; updatedCache?: string }
const desktopSession = new AsyncLocalStorage<DesktopIdentity>()
const desktopLocale = new AsyncLocalStorage<'en' | 'zh-CN'>()
export function withDesktopSession<T>(session: unknown, work: () => T): T { return desktopSession.run({ session, fresh: true }, work) }
export function withDesktopReadSession<T>(session: unknown, options: { fresh: boolean; refresh: () => Promise<unknown> }, work: () => T): T {
  return desktopSession.run({ session, ...options }, work)
}
export function withoutDesktopSession<T>(work: () => T): T { return desktopSession.exit(work) }
export function currentDesktopSession(): unknown { return desktopSession.getStore()?.session }
export function readDesktopSession(fresh: boolean): Promise<unknown> | undefined {
  const scope = desktopSession.getStore()
  if (!scope) return undefined
  if (!fresh || scope.fresh) return Promise.resolve(scope.session)
  // Never use an ambient browser cookie if a refreshed native session was
  // revoked. Null remains the identity of this request after the upgrade.
  scope.refreshing ??= Promise.resolve().then(async () => {
    scope.session = scope.refresh ? await scope.refresh() : null
    scope.fresh = true
    return scope.session
  })
  return scope.refreshing
}
export function desktopHumanSessionId(): string | undefined { return (currentDesktopSession() as { session: { id: string } } | undefined)?.session.id }
export function recordDesktopTokenRotation(token: string): void {
  const scope = desktopSession.getStore()
  if (scope) scope.rotatedToken = token
}
export function desktopRotatedToken(): string | undefined { return desktopSession.getStore()?.rotatedToken }
export function recordDesktopSessionCache(cache: string): void {
  const scope = desktopSession.getStore()
  if (scope) scope.updatedCache = cache
}
export function desktopUpdatedSessionCache(): string | undefined { return desktopSession.getStore()?.updatedCache }
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
