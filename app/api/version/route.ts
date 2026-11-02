import { NextResponse } from 'next/server'

import { APP_BUILD } from '@/lib/app-build'

export const dynamic = 'force-dynamic'

/** The build this deployment serves, so an open page can tell it is out of date. */
export function GET() {
  return NextResponse.json({ build: APP_BUILD }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
