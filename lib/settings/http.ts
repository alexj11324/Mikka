import { NextResponse } from '@/lib/server-runtime/server'

export async function settingsBody(request: Request): Promise<unknown> {
  try { return await request.json() } catch { return null }
}

export async function settingsResponse(read: () => Promise<unknown>) {
  const body = await read()
  const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined
  const explicit = body && typeof body === 'object' && 'status' in body && typeof body.status === 'number' && Number.isInteger(body.status) && body.status >= 400 && body.status <= 599 ? body.status : undefined
  const status = code === 'authRequired' ? 401 : code === 'workspaceAccessDenied' || code === 'workspaceMembershipSuspended' ? 403 : code ? explicit ?? 400 : 200
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export const settingsWorkspaceQuery = (request: Request) => new URL(request.url).searchParams.get('workspaceId') ?? undefined
