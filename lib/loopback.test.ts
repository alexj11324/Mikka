import assert from 'node:assert/strict'
import test from 'node:test'
import { isLoopbackHost } from './loopback'

test('loopback hosts, as URL.hostname gives them and with IPv6 brackets stripped', () => {
  for (const url of ['http://127.0.0.1:3000/', 'http://localhost:3000/', 'http://[::1]:3000/']) assert.equal(isLoopbackHost(new URL(url).hostname), true, url)
  assert.equal(isLoopbackHost('::1'), true)
})

test('anything else is not loopback', () => {
  for (const host of ['mikka.example', '127.0.0.2', '0.0.0.0', 'localhost.example', '[::2]', '::2', '', 'LOCALHOST']) assert.equal(isLoopbackHost(host), false, host)
  // URL lowercases the host, so a typed LOCALHOST still reaches the check as localhost.
  assert.equal(isLoopbackHost(new URL('http://LOCALHOST:3000/').hostname), true)
})
