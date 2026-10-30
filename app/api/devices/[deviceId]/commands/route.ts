import { NextResponse } from 'next/server'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { auth } from '@/lib/api-auth'
import { enqueueDeviceCommand } from '@/lib/device-management'

export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return new Response(null, { status: 401 })
  const { deviceId } = await params
  const parsed = z.object({ kind: z.enum(['redetect', 'restart', 'update']) }).safeParse(await request.json().catch(() => null))
  if (!parsed.success || !z.uuid().safeParse(deviceId).success) return new Response(null, { status: 400 })
  const id = await enqueueDeviceCommand(session.user.id, deviceId, parsed.data.kind)
  return id ? NextResponse.json({ id }, { status: 202 }) : new Response(null, { status: 404 })
}

export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return new Response(null, { status: 401 })
  const { deviceId } = await params
  if (!z.uuid().safeParse(deviceId).success) return new Response(null, { status: 400 })
  const result = await pool.query(`SELECT c.id,c.kind,c."createdAt",c."completedAt",c.error FROM device_management_commands c JOIN devices d ON d.id=c."deviceId" WHERE d.id=$1 AND d."ownerId"=$2 ORDER BY c."createdAt" DESC LIMIT 20`, [deviceId, session.user.id])
  return NextResponse.json({ commands: result.rows }, { headers: { 'Cache-Control': 'no-store' } })
}
