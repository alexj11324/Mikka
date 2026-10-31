import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('next-intl', { namedExports: { useLocale: () => 'zh-CN' } })
mock.module('next/script', { defaultExport: ({ src }: { src: string }) => <script data-src={src} /> })

let Turnstile: typeof import('./turnstile')['Turnstile']
before(async () => { ({ Turnstile } = await import('./turnstile')) })

test('renders the Cloudflare widget when a site key is set', () => {
  const html = renderToStaticMarkup(<Turnstile siteKey="1x00000000000000000000AA" onToken={() => {}} />)
  assert.match(html, /data-slot="turnstile"/)
  assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/)
})

test('renders nothing without a site key (local, previews)', () => {
  assert.equal(renderToStaticMarkup(<Turnstile siteKey="" onToken={() => {}} />), '')
})
