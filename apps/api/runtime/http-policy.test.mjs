import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest as OriginalNextRequest } from 'next/server.js'
import customRoutes from 'next/dist/lib/load-custom-routes.js'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match.js'
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination.js'
import { getRedirectStatus } from 'next/dist/lib/redirect-status.js'
import { applySecurityHeaders, isMachinePath, localizePage, pageRedirect, pageResponse } from './http-policy.mjs'

const request = (path, init) => new Request(`https://example.test${path}`, init)
const render = () => '<html lang="zh-CN"><body>shared app</body></html>'

test('literal trailing slashes match installed Next redirects before machine dispatch for GET and POST', async () => {
  const { redirects } = await customRoutes.default({ basePath: '/mikka', trailingSlash: false, skipTrailingSlashRedirect: false })
  for (const method of ['GET', 'POST']) for (const path of [
    '/mikka/api/version/', '/mikka/w/a%20b/', '/mikka/.well-known/oauth-authorization-server/',
    '/.well-known/workflow/v1/flow/', '/mikka/%61pi/missing/', '/mikka/api%2Fmissing/', '/mikka/api/%E0%A4%A/',
  ]) {
    const input = request(`${path}?x=a%2Fb&x=c+d`, { method, ...(method === 'POST' ? { body: 'unchanged payload' } : {}) })
    const url = new URL(input.url)
    const rule = redirects.find(value => getPathMatch(value.source, { strict: true })(url.pathname))
    assert.ok(rule)
    const params = getPathMatch(rule.source, { strict: true })(url.pathname)
    const target = prepareDestination({ destination: rule.destination, params, query: {}, appendParamsToQuery: false }).parsedDestination.pathname
    const original = Response.redirect(new URL(target + url.search, url), getRedirectStatus(rule))
    const migrated = await pageResponse(input, () => { throw new Error('REDIRECT_MUST_PRECEDE_SPA') })
    assert.equal(migrated.status, original.status)
    assert.equal(migrated.headers.get('location'), original.headers.get('location'))
    assert.equal(input.bodyUsed, false)
  }
  const encodedFinal = await pageResponse(request('/mikka/api/version%2F?x=1'), render)
  assert.equal(encodedFinal.status, 404)
  assert.equal(encodedFinal.headers.has('location'), false)
})

test('page locale uses the same last valid cookie as the installed SDK', async () => {
  for (const cookie of [
    'NEXT_LOCALE=en; NEXT_LOCALE=zh-CN',
    'NEXT_LOCALE=zh-CN; NEXT_LOCALE=en',
    'NEXT_LOCALE=en; NEXT_LOCALE=%E0%A4%A',
    'NEXT_LOCALE=%; NEXT_LOCALE=%65n',
    'NEXT_LOCALE=%FF',
    'NEXT_LOCALE="en"; NEXT_LOCALE=en+',
  ]) {
    const input = request('/mikka/settings', { headers: { cookie, 'accept-language': 'zh-CN', 'sec-fetch-dest': 'document' } })
    const originalValue = new OriginalNextRequest(input).cookies.get('NEXT_LOCALE')?.value
    const expected = originalValue === 'en' ? 'en' : 'zh-CN'
    assert.equal(localizePage(input).locale, expected)
    const response = await pageResponse(input, render)
    if (expected === 'en') assert.equal(response.headers.get('location'), 'https://example.test/mikka/en/settings')
    else assert.match(await response.text(), /lang="zh-CN"/)
    assert.equal(input.headers.get('cookie'), cookie)
  }
})

test('page-only locale and legacy redirects retain query while machine paths never get SPA HTML', async () => {
  assert.equal((await pageResponse(request('/'), render)).headers.get('location'), 'https://example.test/mikka')
  for (const path of ['/mikka/api/missing', '/mikka/%61pi/missing', '/mikka/api%2Fmissing', '/mikka/v1/missing', '/mikka/w/slug', '/.well-known/workflow/v1/flow', '/mikka/%E0%A4%A']) {
    assert.equal(isMachinePath(path), true, path)
    assert.equal((await pageResponse(request(path), render)).status, 404, path)
  }
  const translated = await pageResponse(request('/mikka/en/settings?workspace=1'), render)
  assert.match(await translated.text(), /lang="en"/)
  assert.equal(translated.headers.get('vary'), 'Accept-Language, Cookie')
  assert.equal((await pageResponse(request('/mikka/zh-CN/settings?workspace=1'), render)).headers.get('location'), 'https://example.test/mikka/settings?workspace=1')
  const preview = await pageResponse(request('/mikka/en/preview/settings?workspace=1&invite=1&secret=drop'), render, { production: true })
  assert.equal(preview.headers.get('location'), 'https://example.test/mikka/en/settings/members?workspace=1&invite=1')
})

test('security projection preserves body stream, raw cookies, status and route-specific headers', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 206, headers: { 'content-range': 'bytes 0-9/50', 'referrer-policy': 'no-referrer' } })
  response.crossws = { upgrade() { throw new Response(null, { status: 400 }) } }
  response.headers.append('set-cookie', 'a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT')
  response.headers.append('set-cookie', 'b=; Max-Age=0; Path=/mikka')
  const secured = applySecurityHeaders(request('/mikka/api/stream'), response)
  assert.equal(secured.crossws, response.crossws)
  assert.equal(secured.body, response.body); assert.equal(secured.status, 206)
  assert.equal(secured.headers.get('content-range'), 'bytes 0-9/50')
  assert.equal(secured.headers.get('referrer-policy'), 'no-referrer')
  assert.deepEqual(secured.headers.getSetCookie(), response.headers.getSetCookie())
  await secured.body.cancel(); assert.equal(cancelled, true)
})

test('token pages keep private headers in both locales; document requests alone update locale cookie', async () => {
  for (const path of ['/mikka/reset-password?token=x', '/mikka/en/verify-email?token=x', '/mikka/device?code=x', '/mikka/a/public']) {
    const response = await pageResponse(request(path), render)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const document = await pageResponse(request('/mikka/en', { headers: { 'sec-fetch-dest': 'document' } }), render)
  assert.equal(document.headers.get('set-cookie'), 'NEXT_LOCALE=en; Max-Age=31536000; Path=/mikka; SameSite=Lax')
  assert.equal((await pageResponse(request('/mikka/en'), render)).headers.get('set-cookie'), null)
})

test('only official GitHub cloud installation state continues from the unchanged homepage Setup URL', () => {
  const state = `mikka-gh.00000000-0000-4000-8000-000000000001.${'x'.repeat(43)}`
  const path = `/mikka?installation_id=99&state=${state}&return_to=https://untrusted.example`
  const response = pageRedirect(request(path), { edition: 'cloud' })
  assert.equal(response.status, 302)
  const target = new URL(response.headers.get('location'))
  assert.equal(target.origin, 'https://example.test'); assert.equal(target.pathname, '/mikka/cloud/v1/github/setup')
  assert.deepEqual([...target.searchParams.entries()].sort(), [['installation_id', '99'], ['state', state]])
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('cache-control'), 'no-store')
  for (const candidate of ['/mikka', '/mikka?installation_id=99', '/mikka?installation_id=99&state=ordinary-install', `${path}&state=duplicate`, path.replace('installation_id=99', 'installation_id=invalid'), path.replace('/mikka?', '/mikka/settings?')]) {
    assert.equal(pageRedirect(request(candidate), { edition: 'cloud' }), undefined)
  }
  assert.equal(pageRedirect(request(path), { edition: 'community' }), undefined)
  assert.equal(pageRedirect(request(path, { method: 'POST' }), { edition: 'cloud' }), undefined)
})

test('legacy app hostname permanently redirects every URL to the marketing homepage without carrying paths or query', () => {
  for (const path of ['/', '/settings?section=account', '/mikka/api/auth/callback?code=private', '/nested/']) {
    const input = new Request(`https://mikka.aspectlylabs.com${path}`, { method: 'POST' })
    const response = pageRedirect(input, { legacyHost: 'mikka.aspectlylabs.com' })
    assert.equal(response.status, 301, path)
    assert.equal(response.headers.get('location'), 'https://aspectlylabs.com/mikka', path)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path)
  }
  assert.equal(pageRedirect(request('/settings'), { legacyHost: 'mikka.aspectlylabs.com' }), undefined)
})
