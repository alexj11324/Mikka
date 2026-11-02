import { NextResponse } from 'next/server'

import { APP_BUILD, minDesktopVersion } from '@/lib/app-build'

export const dynamic = 'force-dynamic'

/**
 * The build this deployment serves, so an open page can tell it is out of
 * date, and the oldest desktop app it still serves (MIN_CLIENT_VERSION).
 */
export function GET() {
  return NextResponse.json({ build: APP_BUILD, minDesktopVersion: minDesktopVersion(process.env.MIN_CLIENT_VERSION) }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
