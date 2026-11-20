import { NextResponse } from '@/lib/server-runtime/server'

export async function settingsBody(request: Request): Promise<unknown> {
  try { return await request.json() } catch { return null }
}

export async function settingsResponse(read: () => Promise<unknown>) {
  const body = await read()
  const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined
  const status = code === 'authRequired' ? 401 : code === 'workspaceAccessDenied' || code === 'workspaceMembershipSuspended' ? 403 : code === 'keyboardShortcutConflict' ? 409 : code ? 400 : 200
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export const settingsWorkspaceQuery = (request: Request) => new URL(request.url).searchParams.get('workspaceId') ?? undefined
