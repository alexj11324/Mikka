import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { AppLinks, appLinkFromArgv, appLinkScheme, appLinkUrl, parseAppLink } from './app-link'
import { startBundledLoopback } from './bundled-loopback'
import { startLoopbackAuth } from './loopback'

const id = 'A'.repeat(32)

test('each flavor has its own scheme, never the internal renderer scheme', () => {
  assert.equal(appLinkScheme('prod'), 'mikka-auth')
  assert.equal(appLinkScheme('dev'), 'mikka-dev-auth')
  assert.notEqual(appLinkScheme('prod'), 'mikka')
})

test('only the exact done path with one well-formed id parses', () => {
  assert.equal(parseAppLink(appLinkUrl('mikka-auth', id), 'mikka-auth'), id)
  assert.equal(parseAppLink(`MIKKA-AUTH://auth/done?id=${id}`, 'mikka-auth'), id)
  for (const raw of [
    `mikka-dev-auth://auth/done?id=${id}`,
    `mikka://auth/done?id=${id}`,
    `mikka-auth://app/done?id=${id}`,
    `mikka-auth://auth/done/?id=${id}`,
    `mikka-auth://auth/mikka?id=${id}`,
    `mikka-auth://auth/done?id=${id}&next=/settings`,
    `mikka-auth://auth/done?id=${id}&id=${id}`,
    `mikka-auth://auth/done?id=${id}#x`,
    `mikka-auth://user:pass@auth/done?id=${id}`,
    `mikka-auth://auth:1/done?id=${id}`,
    'mikka-auth://auth/done?id=short',
    `mikka-auth://auth/done?id=${'A'.repeat(31)}%2F`,
    `mikka-auth://auth/done?id=${'A'.repeat(300)}`,
    'mikka-auth://auth/done',
    'https://app.aspectlylabs.com/mikka',
    'javascript:alert(1)',
    42,
    null,
  ]) assert.equal(parseAppLink(raw, 'mikka-auth'), null, String(raw))
})

test('a second instance passes the link as an argument; other arguments are not links', () => {
  const link = appLinkUrl('mikka-auth', id)
  assert.equal(appLinkFromArgv(['/Applications/Mikka.exe', '--flag', link], 'mikka-auth'), link)
  assert.equal(appLinkFromArgv(['/Applications/Mikka.exe', '--flag'], 'mikka-auth'), null)
})

test('only a link this process handed out, and only until it expires, is accepted', () => {
  let now = 1_000
  const links = new AppLinks('mikka-auth', () => now)
  const issued = links.issue()
  assert.ok(parseAppLink(issued, 'mikka-auth'))
  assert.equal(links.accepts(issued), true)
  // The page's 「打开 Mikka」 button may open the same link again.
  assert.equal(links.accepts(issued), true)
  assert.equal(links.accepts(appLinkUrl('mikka-auth', randomBytes(24).toString('base64url'))), false)
  assert.equal(links.accepts(issued.replace('mikka-auth', 'mikka-dev-auth')), false)
  now += 10 * 60_000
  assert.equal(links.accepts(issued), false)
})

test('older links are dropped once too many sign-ins are pending', () => {
  const links = new AppLinks('mikka-auth')
  const first = links.issue()
  for (let index = 0; index < 8; index++) links.issue()
  assert.equal(links.accepts(first), false)
})

test('the callback page opens the app link, then offers it as a button under a nonce-only CSP', async t => {
  const state = randomBytes(32).toString('base64url')
  const code = randomBytes(32).toString('base64url')
  const link = appLinkUrl('mikka-dev-auth', randomBytes(24).toString('base64url'))
  const received: string[] = []
  const listener = await startBundledLoopback(state, value => received.push(value), link)
  t.after(() => listener.close())
  const response = await fetch(`${listener.callback}?state=${state}&code=${code}`, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
  assert.equal(response.status, 200)
  const csp = response.headers.get('content-security-policy') ?? ''
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
  assert.ok(nonce)
  assert.match(csp, /default-src 'none'/)
  assert.doesNotMatch(csp, /unsafe-inline/)
  const html = await response.text()
  assert.equal(html.includes(code), false)
  assert.equal(html.includes(state), false)
  assert.ok(html.includes(`<a id="open" href="${link}" hidden>打开 Mikka</a>`))
  assert.ok(html.includes(`<script nonce="${nonce}">`))
  assert.match(html, /location\.href=open\.href/)
  assert.match(html, /window\.close\(\)/)
  assert.ok(html.includes('"已登录，可以关闭此页"'))
  assert.deepEqual(received, [code])
})

test('the hosted callback page carries the same link in English', async t => {
  const state = 'b'.repeat(32)
  const link = appLinkUrl('mikka-auth', id)
  const listener = await startLoopbackAuth({ state, appUrl: 'https://app.aspectlylabs.com/mikka', link, onFinish: () => {} })
  t.after(() => listener.close())
  const response = await fetch(`${listener.callback}?${new URLSearchParams({ code: 'a'.repeat(32), state, next: '/' })}`, { headers: { 'Accept-Language': 'en-US' } })
  const html = await response.text()
  assert.ok(html.includes(`href="${link}" hidden>Open Mikka</a>`))
  assert.ok(html.includes('"Signed in. You can close this page."'))
})
