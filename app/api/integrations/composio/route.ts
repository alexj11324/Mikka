import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, authBaseURL } from '@/lib/auth'
import { COMPOSIO_TOOLKITS, getComposio, isComposioToolkit } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { withBasePath } from '@/lib/base-path'

const connectSchema = z.object({ toolkit: z.enum(COMPOSIO_TOOLKITS) })
const disconnectSchema = z.object({ accountId: z.string().trim().min(1).max(255) })

function sameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const composio = getComposio()
  const webhookConfigured = Boolean(composio && process.env.COMPOSIO_WEBHOOK_SECRET)
  if (!composio) {
    return NextResponse.json({ configured: false, webhookConfigured, accounts: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
  }
  try {
    const items = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [session.user.id], cursor }))
    const accounts = items
      .filter(account => isComposioToolkit(account.toolkit.slug))
      .map(account => ({ id: account.id, toolkit: account.toolkit.slug, status: account.status }))
    return NextResponse.json({ configured: true, webhookConfigured, accounts }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'integrationsUnavailable' }, { status: 502 })
  }
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  if (!sameOrigin(request)) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403 })
  const parsed = connectSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidIntegration' }, { status: 400 })
  const composio = getComposio()
  if (!composio) return NextResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
  if (!authBaseURL) return NextResponse.json({ error: 'serverUrlNotConfigured' }, { status: 503 })
  try {
    const callbackURL = new URL(withBasePath('/?settings=integrations'), authBaseURL).toString()
    const composioSession = await composio.create(session.user.id)
    const connection = await composioSession.authorize(parsed.data.toolkit, { callbackUrl: callbackURL })
    if (!connection.redirectUrl) return NextResponse.json({ error: 'integrationStartFailed' }, { status: 502 })
    return NextResponse.json({ redirectUrl: connection.redirectUrl }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'integrationStartFailed' }, { status: 502 })
  }
}

export async function DELETE(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  if (!sameOrigin(request)) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403 })
  const parsed = disconnectSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidIntegration' }, { status: 400 })
  const composio = getComposio()
  if (!composio) return NextResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
  try {
    const items = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [session.user.id], cursor }))
    const account = items.find(item => item.id === parsed.data.accountId && isComposioToolkit(item.toolkit.slug))
    if (!account) return NextResponse.json({ error: 'integrationNotFound' }, { status: 404 })
    await composio.connectedAccounts.revoke(account.id)
    return new Response(null, { status: 204 })
  } catch {
    return NextResponse.json({ error: 'integrationDisconnectFailed' }, { status: 502 })
  }
}
