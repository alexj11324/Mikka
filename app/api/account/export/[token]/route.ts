import { auth } from '@/lib/api-auth'
import { buildAccountExport, claimExport } from '@/lib/account/export'

export const dynamic = 'force-dynamic'

const privateHeaders = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

/**
 * `GET /api/account/export/:token`: the 「导出我的数据」 file the email links to.
 * It opens only for the signed-in account that asked for it and only until
 * the link expires (lib/account/export.ts); the file is built at download time.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Sign in to Mikka with the account that asked for this export, then open the link again.', { status: 401, headers: privateHeaders })
  const { token } = await params
  if (!await claimExport(session.user.id, token)) return new Response('This export link has expired or belongs to another account.', { status: 404, headers: privateHeaders })
  const now = new Date()
  const data = await buildAccountExport(session.user.id, now)
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      ...privateHeaders,
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="mikka-export-${now.toISOString().slice(0, 10)}.json"`,
      'content-security-policy': "sandbox; default-src 'none'",
    },
  })
}
