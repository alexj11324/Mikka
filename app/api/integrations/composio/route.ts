import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, authBaseURL } from '@/lib/auth'
import { COMPOSIO_AUTH_CALLBACK_PATH } from '@/lib/auth-return'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { cannotRevokeComposioAccount, COMPOSIO_TOOLKITS, getComposio, isComposioToolkit, renameComposioAccount } from '@/lib/composio'
import { accountUpdateSchema, COMPOSIO_REPLACE_COOKIE, disconnectComposioAccount, toConnectedAccountView } from '@/lib/composio-accounts'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { listComposioPages } from '@/lib/composio-pagination'

const accountIdSchema = z.string().trim().min(1).max(255)
// Connect a new account for a toolkit, or reconnect one the person has.
const connectSchema = z.union([z.object({ toolkit: z.enum(COMPOSIO_TOOLKITS) }).strict(), z.object({ accountId: accountIdSchema }).strict()])
const disconnectSchema = z.object({ accountId: accountIdSchema })

function sameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin
}

type ComposioClient = NonNullable<ReturnType<typeof getComposio>>

/** The person's own account with this id, on one of our toolkits, or undefined. */
async function findOwnAccount(composio: ComposioClient, userId: string, accountId: string) {
  const items = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor }))
  return items.find(item => item.id === accountId && isComposioToolkit(item.toolkit.slug))
}

async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const composio = getComposio()
  const callbackVerifierConfigured = isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)
  const webhookConfigured = Boolean(process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_WEBHOOK_SECRET)
  if (!composio) {
    return NextResponse.json({ configured: false, callbackVerifierConfigured, webhookConfigured, accounts: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
  }
  try {
    const items = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [session.user.id], cursor }))
    const accounts = items.flatMap(account => toConnectedAccountView(account) ?? [])
    return NextResponse.json({ configured: true, callbackVerifierConfigured, webhookConfigured, accounts }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'integrationsUnavailable' }, { status: 502 })
  }
}

async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  if (!sameOrigin(request)) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403 })
  const parsed = connectSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidIntegration' }, { status: 400 })
  const composio = getComposio()
  if (!composio) return NextResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
  if (!isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)) return NextResponse.json({ error: 'callbackVerifierNotConfigured' }, { status: 503 })
  try {
    // Reconnect starts a fresh link for the same toolkit (Composio deprecated
    // refreshing an account in place); the callback then retires the old one.
    const replacing = 'accountId' in parsed.data ? await findOwnAccount(composio, session.user.id, parsed.data.accountId) : undefined
    if ('accountId' in parsed.data && !replacing) return NextResponse.json({ error: 'integrationNotFound' }, { status: 404 })
    const toolkit = 'toolkit' in parsed.data ? parsed.data.toolkit : replacing!.toolkit.slug
    const composioSession = await composio.create(session.user.id)
    const connection = await composioSession.authorize(toolkit)
    if (!connection.redirectUrl) return NextResponse.json({ error: 'integrationStartFailed' }, { status: 502 })
    const response = NextResponse.json({ redirectUrl: connection.redirectUrl }, { headers: { 'Cache-Control': 'no-store' } })
    const cookie = { path: withBasePath(COMPOSIO_AUTH_CALLBACK_PATH), httpOnly: true, sameSite: 'lax' as const, secure: new URL(request.url).protocol === 'https:' }
    if (replacing) response.cookies.set(COMPOSIO_REPLACE_COOKIE, replacing.id, { ...cookie, maxAge: 600 })
    else response.cookies.set(COMPOSIO_REPLACE_COOKIE, '', { ...cookie, maxAge: 0 })
    return response
  } catch {
    return NextResponse.json({ error: 'integrationStartFailed' }, { status: 502 })
  }
}

async function handleDELETE(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  if (!sameOrigin(request)) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403 })
  const parsed = disconnectSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidIntegration' }, { status: 400 })
  const composio = getComposio()
  if (!composio) return NextResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
  try {
    const account = await findOwnAccount(composio, session.user.id, parsed.data.accountId)
    if (!account) return NextResponse.json({ error: 'integrationNotFound' }, { status: 404 })
    await disconnectComposioAccount(composio.connectedAccounts, account.id, cannotRevokeComposioAccount)
    return new Response(null, { status: 204 })
  } catch {
    return NextResponse.json({ error: 'integrationDisconnectFailed' }, { status: 502 })
  }
}

/** Turns an account on or off (Composio's `isDisabled`), or renames it. */
async function handlePATCH(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  if (!sameOrigin(request)) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403 })
  const parsed = accountUpdateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidIntegration' }, { status: 400 })
  const composio = getComposio()
  if (!composio) return NextResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
  try {
    const account = await findOwnAccount(composio, session.user.id, parsed.data.accountId)
    if (!account) return NextResponse.json({ error: 'integrationNotFound' }, { status: 404 })
    if ('enabled' in parsed.data) {
      if (parsed.data.enabled) await composio.connectedAccounts.enable(account.id)
      else await composio.connectedAccounts.disable(account.id)
    } else {
      await renameComposioAccount(account.id, parsed.data.alias)
    }
    return new Response(null, { status: 204 })
  } catch {
    return NextResponse.json({ error: 'integrationUpdateFailed' }, { status: 502 })
  }
}

export const GET = withRequestLog('/api/integrations/composio', handleGET)
export const POST = withRequestLog('/api/integrations/composio', handlePOST)
export const DELETE = withRequestLog('/api/integrations/composio', handleDELETE)
export const PATCH = withRequestLog('/api/integrations/composio', handlePATCH)
