// Pure: the one rule for where the daemon sends a run's token.
import assert from 'node:assert/strict'
import test from 'node:test'
import { trustedServerEndpoint } from '../src/trusted-endpoint.ts'

const trusted = (url: string) => trustedServerEndpoint(new URL(url))

test('https is trusted on any host', () => {
  assert.equal(trusted('https://mikka.example/api/mcp'), true)
  assert.equal(trusted('https://mikka.example:8443/mikka/api/runs/github-token'), true)
})

test('http is trusted only on loopback', () => {
  for (const url of ['http://127.0.0.1:3000/api/mcp', 'http://localhost:3000/api/mcp', 'http://[::1]:3000/api/mcp']) assert.equal(trusted(url), true, url)
  for (const url of ['http://mikka.example/api/mcp', 'http://10.0.0.5/api/mcp', 'http://127.0.0.2/api/mcp', 'http://localhost.example/api/mcp']) assert.equal(trusted(url), false, url)
})

test('credentials, query and fragment are refused', () => {
  for (const url of ['https://user@mikka.example/api/mcp', 'https://user:pass@mikka.example/api/mcp', 'https://:pass@mikka.example/api/mcp',
    'https://mikka.example/api/mcp?x=1', 'https://mikka.example/api/mcp#x', 'http://user@127.0.0.1/api/mcp']) assert.equal(trusted(url), false, url)
})

test('other protocols are refused', () => {
  for (const url of ['ws://127.0.0.1/api/mcp', 'wss://mikka.example/api/mcp', 'ftp://mikka.example/api/mcp', 'file:///api/mcp']) assert.equal(trusted(url), false, url)
})
