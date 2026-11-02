import { NextResponse } from 'next/server'

import { APP_BUILD } from '@/lib/app-build'
import { MIN_MOBILE_BUILD, MOBILE_UPDATE_URL } from '@/lib/mobile-min-build'

export const dynamic = 'force-dynamic'

/**
 * The build this deployment serves, so an open page can tell it is out of
 * date; and, for the iOS app's launch, the oldest native build it accepts and
 * where to get a newer one. Read before sign-in, so it needs no session.
 */
export function GET() {
  return NextResponse.json(
    { build: APP_BUILD, minMobileBuild: MIN_MOBILE_BUILD, mobileUpdateUrl: MOBILE_UPDATE_URL },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
