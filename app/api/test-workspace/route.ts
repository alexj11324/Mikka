import { createHmac } from 'node:crypto'
import { auth, authBaseURL } from '@/lib/auth'

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') return new Response(null, { status: 404 })

  const origin = request.headers.get('origin')
  const trustedOrigins = ['http://localhost:3000', authBaseURL, process.env.V0_RUNTIME_URL, process.env.V0_DEV_APP_URL, process.env.V0_BUILD_URL, process.env.V0_SANDBOX_URL]
    .filter((value): value is string => Boolean(value))
    .map(value => new URL(value).origin)
  if (!origin || !trustedOrigins.includes(origin)) return new Response(null, { status: 403 })

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) return new Response(null, { status: 503 })

  const fingerprint = createHmac('sha256', secret).update('orvilo-preview-test-account').digest('hex')
  const credentials = { email: `orvilo-preview-${fingerprint.slice(0, 16)}@example.com`, password: fingerprint }
  try {
    let response = await auth.api.signInEmail({ body: credentials, headers: request.headers, asResponse: true })
    if (!response.ok) {
      response = await auth.api.signUpEmail({ body: { ...credentials, name: 'Orvilo 测试账号' }, headers: request.headers, asResponse: true })
      if (!response.ok) response = await auth.api.signInEmail({ body: credentials, headers: request.headers, asResponse: true })
    }
    if (!response.ok) return new Response(null, { status: 503 })

    const headers = new Headers({ 'Cache-Control': 'no-store' })
    for (const cookie of response.headers.getSetCookie()) headers.append('Set-Cookie', cookie)
    return new Response(null, { status: 204, headers })
  } catch {
    console.error('开发测试账号登录失败。')
    return new Response(null, { status: 503 })
  }
}
