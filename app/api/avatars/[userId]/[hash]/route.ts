import { readAvatar } from '@/lib/account/avatar'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/avatars/:userId/:sha256`: an uploaded profile picture. Avatars show
 * wherever the person does (teammates, the iOS app), like provider pictures,
 * so this needs no session. The URL names the exact bytes, so it never
 * changes; a replaced picture is a 404. Browsers keep it for a day only, so a
 * removed picture or deleted account does not linger in caches for long.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string; hash: string }> }) {
  const { userId, hash } = await params
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId) || !/^[a-f0-9]{64}$/.test(hash)) return new Response('Not found', { status: 404 })
  const found = await readAvatar(userId, hash)
  if (!found) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
  return new Response(new Uint8Array(found.bytes), {
    headers: {
      'content-type': found.contentType,
      'content-length': String(found.bytes.length),
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
}
