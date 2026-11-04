import { NextResponse } from 'next/server'

import { APP_BUILD, minDesktopVersion } from '@/lib/app-build'
import { MIN_MOBILE_BUILD, MOBILE_UPDATE_URL } from '@/lib/mobile-min-build'

export const dynamic = 'force-dynamic'

/**
 * The build this deployment serves, so an open page can tell it is out of
 * date; for the iOS app's launch, the oldest native build it accepts and
 * where to get a newer one; and the oldest desktop app it still serves
 * (MIN_CLIENT_VERSION). Read before sign-in, so it needs no session.
 */
export function GET() {
  return NextResponse.json(
    { build: APP_BUILD, deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null, minMobileBuild: MIN_MOBILE_BUILD, mobileUpdateUrl: MOBILE_UPDATE_URL, minDesktopVersion: minDesktopVersion(process.env.MIN_CLIENT_VERSION) },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
