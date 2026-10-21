import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { multiSession } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { pool } from '@/lib/db'

export const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
export const authBaseURL = process.env.BETTER_AUTH_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.V0_RUNTIME_URL)

export const auth = betterAuth({
  appName: 'Orvilo2',
  onAPIError: { errorURL: '/sign-in?oauth=failed' },
  database: pool,
  socialProviders: githubEnabled ? {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  } : {},
  baseURL: authBaseURL,
  emailAndPassword: { enabled: true, autoSignIn: true },
  trustedOrigins: [
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000', ...[process.env.V0_RUNTIME_URL, process.env.V0_DEV_APP_URL, process.env.V0_BUILD_URL, process.env.V0_SANDBOX_URL].filter((value): value is string => !!value)] : []),
    ...(process.env.NODE_ENV === 'production' ? [...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []), ...(process.env.VERCEL_PROJECT_PRODUCTION_URL ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`] : [])] : []),
  ],
  plugins: [multiSession(), nextCookies()],
  hooks: {
    after: createAuthMiddleware(async ctx => {
      // Preserve sessions issued before multi-session was enabled when adding the first extra account.
      if (ctx.path !== '/get-session' || !ctx.request || ctx.headers?.get('cookie')?.includes('_multi-')) return
      const active = ctx.context.session
      if (!active || active.session.expiresAt <= new Date()) return
      const cookie = ctx.context.authCookies.sessionToken
      await ctx.setSignedCookie(`${cookie.name}_multi-${active.session.token.toLowerCase()}`, active.session.token, ctx.context.secret, {
        ...cookie.attributes,
        maxAge: Math.max(0, Math.floor((active.session.expiresAt.getTime() - Date.now()) / 1000)),
      })
    }),
  },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  ...(process.env.NODE_ENV === 'development' ? { advanced: {
    // The cross-site v0 preview requires secure SameSite=None session cookies.
    defaultCookieAttributes: { sameSite: 'none' as const, secure: true },
  } } : {}),
})
