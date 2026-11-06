import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { localizePage } from '../../api/runtime/http-policy.mjs'
import { browserModule } from './test-module.mjs'

async function navigation(url, callback) {
  const window = new Window({ url })
  const previous = new Map()
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : key === 'document' ? window.document : window[key], configurable: true, writable: true })
  }
  const api = await browserModule(`
    export { createElement } from 'react'
    export { createRoot } from 'react-dom/client'
    export { flushSync } from 'react-dom'
    export { NextIntlClientProvider } from 'next-intl'
    export { useRouter } from './apps/desktop/src/renderer/i18n-navigation.tsx'
  `)
  const root = api.createRoot(window.document.body.appendChild(window.document.createElement('div')))
  let router
  function Probe() { router = api.useRouter(); return null }
  const render = locale => {
    api.flushSync(() => root.render(api.createElement(api.NextIntlClientProvider, { locale, messages: {}, timeZone: 'UTC' }, api.createElement(Probe))))
    return router
  }
  const writes = []
  let prototype = window.document
  let cookie
  while (!cookie) { prototype = Object.getPrototypeOf(prototype); cookie = Object.getOwnPropertyDescriptor(prototype, 'cookie') }
  Object.defineProperty(window.document, 'cookie', {
    configurable: true,
    get: () => cookie.get.call(window.document),
    set: value => { writes.push(value); cookie.set.call(window.document, value) },
  })
  try { await callback({ window, render, writes }) }
  finally {
    api.flushSync(() => root.unmount())
    await window.happyDOM.close()
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value)
      else delete globalThis[key]
    }
  }
}

const request = (window, url = window.location.href) => new Request(url, {
  headers: { cookie: window.document.cookie, 'accept-language': 'en', 'sec-fetch-dest': 'document' },
})

test('explicit en-to-zh web navigation retains the chosen language through server refresh and reentry', () => navigation('https://app.example/mikka/en/settings?section=general&workspace=team', async ({ window, render, writes }) => {
  window.document.cookie = 'NEXT_LOCALE=en; Path=/mikka'
  window.document.cookie = 'other-preference=retained; Path=/mikka'
  writes.length = 0
  render('en').replace({ pathname: '/settings', query: { section: 'general', workspace: 'team' } }, { locale: 'zh-CN' })
  assert.equal(window.location.href, 'https://app.example/mikka/settings?section=general&workspace=team')
  assert.deepEqual(writes, ['NEXT_LOCALE=zh-CN; Max-Age=31536000; Path=/mikka; SameSite=Lax'])
  assert.match(window.document.cookie, /other-preference=retained/)
  for (const url of [window.location.href, 'https://app.example/mikka/settings?section=general']) {
    const result = localizePage(request(window, url))
    assert.equal(result.locale, 'zh-CN')
    assert.equal(result.redirect, undefined)
  }
  window.happyDOM.setURL('https://app.example/another-application')
  assert.equal(window.document.cookie, '')
}))

test('explicit zh-to-en web navigation retains the language and query on a fresh unprefixed entry', () => navigation('https://app.example/mikka/settings?section=general&workspace=team', async ({ window, render, writes }) => {
  window.document.cookie = 'NEXT_LOCALE=zh-CN; Path=/mikka'
  writes.length = 0
  render('zh-CN').push('/settings?section=general&workspace=team', { locale: 'en' })
  assert.equal(window.location.href, 'https://app.example/mikka/en/settings?section=general&workspace=team')
  assert.deepEqual(writes, ['NEXT_LOCALE=en; Max-Age=31536000; Path=/mikka; SameSite=Lax'])
  assert.equal(localizePage(request(window)).redirect, undefined)
  const result = localizePage(request(window, 'https://app.example/mikka/settings?section=general&workspace=team'))
  assert.equal(result.locale, 'en')
  assert.equal(result.redirect.headers.get('location'), window.location.href)
}))

test('ordinary navigation and the native custom scheme do not write a web locale cookie', async () => {
  await navigation('https://app.example/mikka/en/settings', async ({ window, render, writes }) => {
    window.document.cookie = 'NEXT_LOCALE=en; Path=/mikka'
    writes.length = 0
    const router = render('en')
    router.push('/settings?section=privacy')
    router.replace('/settings?section=general', { locale: 'en' })
    assert.deepEqual(writes, [])
  })
  await navigation('mikka://app/mikka/en/settings', async ({ window, render, writes }) => {
    render('en').replace('/settings?section=general', { locale: 'zh-CN' })
    assert.equal(window.location.href, 'mikka://app/mikka/settings?section=general')
    assert.deepEqual(writes, [])
  })
})
