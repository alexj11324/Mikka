import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { downloadOfficialAsset } from './install-electron.mjs'

const version = '45.1.0', filename = `electron-v${version}-linux-x64.zip`
const bytes = Buffer.from('pinned official asset fixture')
const checksum = createHash('sha256').update(bytes).digest('hex')
const asset = { name: filename, id: 123, state: 'uploaded', digest: `sha256:${checksum}` }

test('official asset download keeps authentication on the API and writes the exact CDN body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-electron-download-'))
  const calls = [], destination = join(directory, 'electron.zip')
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) return Response.json({ assets: [asset] })
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/owned.zip?signature=fixture' } })
    return new Response(bytes)
  }
  try {
    await downloadOfficialAsset({ version, filename, checksum, destination, token: 'fixture-token', fetchImpl })
    assert.deepEqual(await readFile(destination), bytes)
    assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-token')
    assert.equal(calls[1].options.headers.authorization, 'Bearer fixture-token')
    assert.equal(calls[2].options.headers, undefined)
    assert.equal(calls[2].options.redirect, 'error')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a release digest differing from the locked package fails before fetching any asset', async () => {
  let requests = 0
  await assert.rejects(downloadOfficialAsset({ version, filename, checksum, destination: '/unused',
    fetchImpl: async () => { requests++; return Response.json({ assets: [{ ...asset, digest: 'sha256:' + '0'.repeat(64) }] }) } }),
  { code: 'ELECTRON_ASSET_DIGEST_MISMATCH' })
  assert.equal(requests, 1)
})

test('an off-domain asset redirect is rejected without sending the token or fetching it', async () => {
  let requests = 0
  await assert.rejects(downloadOfficialAsset({ version, filename, checksum, destination: '/unused', token: 'fixture-token',
    fetchImpl: async () => ++requests === 1 ? Response.json({ assets: [asset] })
      : new Response(null, { status: 302, headers: { location: 'https://example.invalid/asset.zip' } }) }),
  { code: 'ELECTRON_ASSET_REDIRECT_INVALID' })
  assert.equal(requests, 2)
})

test('a mismatched filename cannot select another platform or version from release metadata', async () => {
  await assert.rejects(downloadOfficialAsset({ version, filename: 'another.zip', checksum, destination: '/unused',
    fetchImpl: () => assert.fail('network must not start') }), { code: 'ELECTRON_FILENAME_INVALID' })
})
