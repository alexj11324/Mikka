import test from 'node:test'
import assert from 'node:assert/strict'
import { daemonCommands } from '@/lib/daemon-commands'
import { publicAppOrigin } from './public-origin'
import type { MikkaWindow } from './detect'

function target(origin: string, serverUrl?: string, bundled = true): MikkaWindow {
  return { location: { origin }, ...(serverUrl ? { mikka: { app: { runtime: 'electron', serverUrl }, ...(bundled ? { bundled: {} } : {}) } } : {}) } as MikkaWindow
}

test('web and hosted pages retain their actual public origin, including isolated backend ports', () => {
  assert.equal(publicAppOrigin(null), '')
  assert.equal(publicAppOrigin(target('https://app.example')), 'https://app.example')
  assert.equal(publicAppOrigin(target('http://127.0.0.1:3002', 'https://unused.example/mikka', false)), 'http://127.0.0.1:3002')
})

test('bundled share URLs and runnable daemon commands use the configured backend instead of the local scheme', () => {
  const origin = publicAppOrigin(target('mikka://app', 'http://127.0.0.1:3000/mikka'))
  assert.equal(new URL('/mikka/a/mks_public-example', origin).href, 'http://127.0.0.1:3000/mikka/a/mks_public-example')
  const commands = daemonCommands({ origin, basePath: '/mikka', packageName: '@aspectlylabs/mikka' })
  assert.match(commands.login, /127\.0\.0\.1:3000/)
  assert.ok(!Object.values(commands).some(command => command.includes('mikka://')))
})

test('a malformed backend cannot place credentials or a non-HTTP scheme into a public link', () => {
  for (const backend of ['mikka://app/mikka', 'https://user:password@app.example/mikka', 'data:text/plain,example']) {
    assert.throws(() => publicAppOrigin(target('mikka://app', backend)), /desktop_backend_origin_invalid/)
  }
})
