import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { registeredScheme } from './native-code-cache.mjs'

test('the shipped local scheme enables ordinary V8 caching without adding execution privileges', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.deepEqual(registeredScheme(source), { scheme: 'mikka', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true,
  } })
})

test('the real-runtime probe cannot silently extract another registration or execute source expressions', () => {
  const registration = 'protocol.registerSchemesAsPrivileged([{scheme:"mikka",privileges:{standard:true,codeCache:true}}]);'
  assert.equal(registeredScheme(registration).privileges.codeCache, true)
  for (const source of ['', registration + registration, registration.replace('"mikka"', '"foreign"'),
    registration.replace('codeCache:true', 'codeCache:process.env.ALLOW')]) assert.throws(() => registeredScheme(source))
})
