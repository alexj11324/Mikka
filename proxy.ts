import createMiddleware from 'next-intl/middleware'

import { routing } from './i18n/routing'

export default createMiddleware(routing)

export const config = {
  // Pages only. `/api` (better-auth and device SSH), `/v1` (daemon API),
  // `/_next` and dotted static assets must reach their own routes untouched.
  matcher: '/((?!api|v1|trpc|_next|_vercel|__nextjs|.*\\..*).*)',
}
