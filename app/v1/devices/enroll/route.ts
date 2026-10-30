import { NextResponse } from 'next/server'
import { consumeDeviceEnrollment } from '@/lib/device-enrollment'

export async function POST(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  if (!/^orv_[A-Za-z0-9_-]{43}$/.test(token)) return new Response(null, { status: 401 })
  const credential = await consumeDeviceEnrollment(token)
  return credential ? NextResponse.json({ credential }, { headers: { 'Cache-Control': 'no-store' } }) : new Response(null, { status: 401 })
}
