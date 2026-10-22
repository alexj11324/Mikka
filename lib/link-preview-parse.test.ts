import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, parsePreview } from './link-preview-parse'

test('parsePreview reads Open Graph tags and resolves relative URLs', () => {
  const html = `<html><head><title>Fallback</title>
    <meta property="og:title" content="Tern &amp; Stencil">
    <meta content="A native terminal" property="og:description">
    <meta property="og:image" content="/og.png"><meta property="og:site_name" content="Stencil">
    <link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/favicon.svg">
  </head><body><meta property="og:title" content="ignored"></body></html>`
  assert.deepEqual(parsePreview(html, 'https://stencil.so/tern'), {
    siteName: 'Stencil', title: 'Tern & Stencil', description: 'A native terminal',
    image: 'https://stencil.so/og.png', icon: 'https://stencil.so/favicon.svg',
  })
})

test('parsePreview falls back to <title> and /favicon.ico, and drops non-web URLs', () => {
  assert.deepEqual(parsePreview('<head><title> Plain page </title><meta name="twitter:image" content="javascript:alert(1)"></head>', 'https://example.com/a/b'), {
    siteName: null, title: 'Plain page', description: null, image: null, icon: 'https://example.com/favicon.ico',
  })
})

test('isPrivateAddress blocks loopback, private and link-local addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(address), true, address)
  for (const address of ['140.82.112.3', '2606:4700::1111']) assert.equal(isPrivateAddress(address), false, address)
})
