import { after, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { coordinatorRuntimeSchema } from '@mikka/protocol/coordinator'
import { nativeCoordinatorEnabled, nativeCoordinatorStore } from '@/lib/coordinator/native'
import { NativeCoordinatorError } from '@/lib/coordinator/native-store'
import { wakeCoordinator } from '@/lib/coordinator/wake'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  return NextResponse.json({ available: nativeCoordinatorEnabled(), runtime: nativeCoordinatorEnabled() ? await nativeCoordinatorStore.runtime(session.user.id) : { harness: 'ai_sdk' } }, { headers: { 'Cache-Control': 'private, no-store' } })
}
export async function PUT(request: Request) {
  if (!nativeCoordinatorEnabled()) return NextResponse.json({ error: 'notEnabled' }, { status: 404 })
  if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'originMismatch' }, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const parsed = coordinatorRuntimeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidRuntime' }, { status: 400 })
  try {
    await nativeCoordinatorStore.setRuntime(session.user.id, parsed.data)
    after(() => wakeCoordinator(session.user.id))
    return NextResponse.json({ runtime: parsed.data })
  } catch (error) {
    if (error instanceof NativeCoordinatorError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
