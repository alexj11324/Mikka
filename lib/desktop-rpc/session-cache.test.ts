import assert from 'node:assert/strict'
import test from 'node:test'
import { DESKTOP_SESSION_CACHE_HEADER as header, DESKTOP_SESSION_CACHE_MAX as maximum, desktopSessionCacheFromHeaders, nativeSessionHeaders, validDesktopSessionCache, withDesktopSessionCache } from './session-cache'
import { recordNativeSessionCache, withNativeSessionCache } from './session-cache-context'

const cookieName = 'better-auth.session_data'

test('the native cache is bounded opaque base64url, with no caller cookies or identity headers', () => {
  for (const value of [undefined, null, '', 'bad value', 'a=b', 'a.b', 'a;other=1', 'a'.repeat(maximum + 1)]) assert.equal(validDesktopSessionCache(value), false)
  assert.equal(validDesktopSessionCache('a_-9'.repeat(maximum / 4)), true)
  const source = new Headers({ authorization: 'Bearer native', cookie: 'better-auth.session_token=foreign; mikka-workspace=other', [header]: 'valid_-9' })
  const enabled = nativeSessionHeaders(source, cookieName, true)
  assert.equal(enabled.get('authorization'), 'Bearer native')
  assert.equal(enabled.get('cookie'), `${cookieName}=valid_-9`)
  assert.equal(enabled.has(header), false)
  assert.equal(source.has(header), true)
  assert.match(source.get('cookie')!, /foreign/)
  assert.equal(nativeSessionHeaders(source, cookieName).has('cookie'), false)
  source.set(header, 'invalid=value')
  assert.equal(nativeSessionHeaders(source, cookieName, true).has('cookie'), false)
})

test('only the SDK session-data cookie is extracted, with bounded ordered chunk support and explicit clearing', () => {
  const cookies = (...values: string[]) => { const result = new Headers(); for (const value of values) result.append('set-cookie', value); return result }
  assert.equal(desktopSessionCacheFromHeaders(cookies('better-auth.session_token=secret; HttpOnly', 'oauth_state=private'), cookieName), undefined)
  assert.equal(desktopSessionCacheFromHeaders(cookies(`${cookieName}=signed_-9; HttpOnly; Max-Age=300`), cookieName), 'signed_-9')
  assert.equal(desktopSessionCacheFromHeaders(cookies(`${cookieName}=; Max-Age=0`), cookieName), '')
  assert.equal(desktopSessionCacheFromHeaders(cookies(`${cookieName}.1=def; HttpOnly`, `${cookieName}.0=abc; HttpOnly`), cookieName), 'abcdef')
  assert.equal(desktopSessionCacheFromHeaders(cookies(`${cookieName}=; Max-Age=0`, `${cookieName}.0=abc`, `${cookieName}.1=def`), cookieName), 'abcdef')
  assert.equal(desktopSessionCacheFromHeaders(cookies(`${cookieName}.0=abc`, `${cookieName}.2=def`), cookieName), '')
  assert.equal(desktopSessionCacheFromHeaders(cookies(`${cookieName}.0=; Max-Age=0`), cookieName), '')
  assert.equal(desktopSessionCacheFromHeaders(cookies(`${cookieName}=${'x'.repeat(maximum + 1)}`), cookieName), '')
})

test('HTTP requests are sanitized before the SDK bearer hook sees either request or context headers', async () => {
  const seen: Request[] = []
  const handler = withDesktopSessionCache(async request => { seen.push(request); return new Response(null) }, async () => cookieName)
  const web = new Request('http://localhost/api/auth/get-session', { headers: { cookie: 'web=unchanged' } })
  await handler(web)
  assert.equal(seen[0], web)
  const native = new Request('http://localhost/api/auth/get-session', { headers: { authorization: 'Bearer native', cookie: 'foreign=ignored', [header]: 'signed_9' } })
  await handler(native)
  assert.equal(seen[1].headers.get('cookie'), `${cookieName}=signed_9`)
  assert.equal(seen[1].headers.has(header), false)
  assert.equal(native.headers.get('cookie'), 'foreign=ignored')
  const invalid = new Request(native, { headers: { authorization: 'Bearer invalid', cookie: 'foreign=ignored' } })
  await handler(invalid)
  assert.equal(seen[2].headers.has('cookie'), false)
})

test('replacement proofs stay in their own bearer response and cannot override explicit rotation clearing', async () => {
  const response = (token: string, supplied: string, explicit = false) => {
    const headers = new Headers({ authorization: `Bearer ${token}`, 'x-mikka-client': 'desktop' })
    return withNativeSessionCache(headers, async () => {
      await Promise.resolve()
      recordNativeSessionCache(new Headers({ authorization: `Bearer ${supplied}` }), `proof_${token}`)
      return new Response(null, { headers: explicit ? { [header]: '' } : undefined })
    })
  }
  const [first, second, foreign, rotated] = await Promise.all([response('one', 'one'), response('two', 'two'), response('one', 'two'), response('one', 'one', true)])
  assert.equal(first.headers.get(header), 'proof_one')
  assert.equal(second.headers.get(header), 'proof_two')
  assert.equal(foreign.headers.has(header), false)
  assert.equal(rotated.headers.get(header), '')
  const webHeaders = new Headers({ cookie: 'web=unchanged' })
  const web = await withNativeSessionCache(webHeaders, async () => { recordNativeSessionCache(webHeaders, 'ignored'); return new Response(null) })
  assert.equal(web.headers.has(header), false)
})
