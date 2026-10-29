import assert from 'node:assert/strict'
import { test } from 'node:test'
import { daemonCommands } from './daemon-commands'

test('installation and login use the exact Preview origin and base path', () => {
  assert.deepEqual(daemonCommands({ origin: 'https://mikka-sha.vercel.app', basePath: '/mikka', packageName: '@mikka/daemon' }), {
    install: 'npm install --global @mikka/daemon',
    login: "mikka daemon login --server 'https://mikka-sha.vercel.app/mikka'",
    start: "mikka daemon --server 'https://mikka-sha.vercel.app/mikka'",
  })
  const noPrefix = daemonCommands({ origin: 'https://preview.example', basePath: '', packageName: 'approved-package' })
  assert.equal(noPrefix.login, "mikka daemon login --server 'https://preview.example'")
})

test('the production default does not need a server flag', () => {
  const commands = daemonCommands({ origin: 'https://app.aspectlylabs.com', basePath: '/mikka', packageName: '@mikka/daemon' })
  assert.equal(commands.login, 'mikka daemon login')
  assert.equal(commands.start, 'mikka daemon')
})

test('copyable commands reject shell syntax and non-origin configuration', () => {
  const valid = { origin: 'https://preview.example', basePath: '/mikka', packageName: '@mikka/daemon' }
  for (const packageName of ['x; echo secret', '--registry=evil', '$(whoami)', 'git+https://example/x']) {
    assert.throws(() => daemonCommands({ ...valid, packageName }))
  }
  for (const origin of ['file:///tmp/x', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?query=1']) {
    assert.throws(() => daemonCommands({ ...valid, origin }))
  }
  assert.throws(() => daemonCommands({ ...valid, basePath: "/mikka' && false" }))
})
