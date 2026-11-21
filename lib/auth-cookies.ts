import { createAuthMiddleware } from 'better-auth/api'
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies/utils'
import { currentRequestScope } from '../apps/api/src/context'

/**
 * Writes Better Auth's response cookies into the request's cookie journal.
 *
 * The request owns one CookieJar. `apps/api/src/application.ts` commits it to
 * the real response at the transport boundary, so a Set-Cookie the auth handler
 * produced reaches the browser without this module touching the response.
 *
 * This replaces the framework integration, whose only job was the same copy. It
 * must stay the last plugin: a later plugin's `after` hook could set cookies this
 * one never sees.
 *
 * `ctx._flag === 'router'` marks an internal call that must not mutate the
 * ambient response, matching the integration it replaces.
 */
export function mikkaCookies() {
  return {
    id: 'mikka-cookies',
    hooks: {
      after: [{
        matcher: () => true,
        handler: createAuthMiddleware(async ctx => {
          if ('_flag' in ctx && ctx._flag === 'router') return
          const returned = ctx.context.responseHeaders
          if (!(returned instanceof Headers)) return
          const raw = returned.get('set-cookie')
          if (!raw) return
          const scope = currentRequestScope()
          if (!scope) return
          for (const [name, value] of parseSetCookieHeader(raw)) {
            if (!name) continue
            try { scope.cookies.set(name, value.value, toCookieOptions(value)) } catch { /* an ended response owns its cookies */ }
          }
        }),
      }],
    },
  }
}
