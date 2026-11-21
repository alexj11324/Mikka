import test from 'node:test'
import assert from 'node:assert/strict'
import { daemonCommands } from '@/lib/daemon-commands'
import { publicAppOrigin, publicServiceAddress, publicServiceLink } from './public-origin'
import { installWebSelection } from '@/lib/web-connection/selection'
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


test('workspace, invite, artifact and daemon links follow the selected server and installation prefix', () => {
  const screen = target('https://official.test')
  let account: { server: string } | null = { server: 'https://self.test:9443/dept/mikka' }
  installWebSelection(() => ({ account, version: 1 }))
  try {
    for (const path of ['/w/example', '/invite/sample', '/a/sample']) {
      assert.equal(publicServiceLink(path, screen), 'https://self.test:9443/dept/mikka' + path)
    }
    assert.match(daemonCommands({ ...publicServiceAddress(screen), packageName: 'mikka' }).login, /self\.test:9443\/dept\/mikka/)
    assert.throws(() => publicServiceLink('//other.test/invite', screen), /invalid_service_link/)
    assert.throws(() => publicServiceLink('/../../cross-prefix', screen), /invalid_service_link/)
    account = { server: 'https://root.test' }
    assert.equal(publicServiceLink('/invite/sample', screen), 'https://root.test/invite/sample')
    account = null
    assert.equal(new URL(publicServiceLink('/a/sample', screen)).origin, screen.location.origin)
    assert.equal(publicServiceLink('/a/sample', target('mikka://app', 'https://native.test/native')), 'https://native.test/native/a/sample')
  } finally { installWebSelection(() => ({ account: null, version: 2 })) }
})
