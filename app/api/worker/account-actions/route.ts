import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyRunToken, resumeAccountActions } from '@/lib/mcp/worker'
export const dynamic = 'force-dynamic'
/** Same run-token boundary as worker MCP; GET performs no remote provider call. */
export async function GET(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
  const auth = await verifyRunToken(request, token)
  if (!auth) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const parsed = z.uuid().optional().safeParse(new URL(request.url).searchParams.get('operationId') ?? undefined)
  if (!parsed.success) return NextResponse.json({ error: 'invalidOperationId' }, { status: 400 })
  try { return NextResponse.json({ actions: await resumeAccountActions(auth, parsed.data) }, { headers: { 'Cache-Control': 'private, no-store' } }) }
  catch { return NextResponse.json({ error: 'accountActionUnavailable' }, { status: 403 }) }
}
