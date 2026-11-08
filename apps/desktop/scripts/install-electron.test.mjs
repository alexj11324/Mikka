import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { downloadOfficialAsset, seedBuilderChecksum } from './install-electron.mjs'

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

test('the native ARM64 asset can be streamed directly from the authenticated official API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-electron-arm64-'))
  const filename = `electron-v${version}-darwin-arm64.zip`, destination = join(directory, filename)
  let requests = 0
  try {
    await downloadOfficialAsset({ version, filename, checksum, destination, platform: 'darwin', arch: 'arm64',
      fetchImpl: async () => ++requests === 1 ? Response.json({ assets: [{ ...asset, name: filename }] }) : new Response(bytes) })
    assert.deepEqual(await readFile(destination), bytes)
    assert.equal(requests, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the locked SDK cache and checksum seed are consumed by the actual builder without network or disabled checksums', async () => {
  const require = createRequire(new URL('../package.json', import.meta.url))
  const electron = createRequire(await realpath(require.resolve('electron/package.json')))
  const builder = createRequire(await realpath(require.resolve('electron-builder/package.json')))
  const { downloadArtifact, ElectronDownloadCacheMode } = electron('@electron/get')
  const { buildElectronArtifactConfig, downloadElectronArtifactZip } = builder('app-builder-lib/out/util/electronGet.js')
  const cache = await mkdtemp(join(tmpdir(), 'mikka-electron-builder-cache-'))
  const filename = `electron-v${version}-darwin-arm64.zip`
  const options = { version, arch: 'arm64', platformName: 'darwin', artifactName: 'electron', cacheDir: cache }
  try {
    const archive = await downloadArtifact({ version, artifactName: 'electron', platform: 'darwin', arch: 'arm64',
      cacheRoot: cache, cacheMode: ElectronDownloadCacheMode.ReadWrite, checksums: { [filename]: checksum },
      downloader: { download: async (_url, target) => { await writeFile(target, bytes) } } })
    assert.equal((await buildElectronArtifactConfig(options)).checksums, undefined)
    await seedBuilderChecksum(archive, version, filename, checksum)
    const config = await buildElectronArtifactConfig(options)
    assert.equal(config.checksums[filename], checksum)
    assert.notEqual(config.unsafelyDisableChecksums, true)
    const actual = await downloadElectronArtifactZip({ ...options, electronDownload: { mirrorOptions: undefined,
      downloader: { download: () => assert.fail('a validated cache hit must not fetch ZIP or SHASUMS') } } })
    assert.equal(actual, archive)
  } finally { await rm(cache, { recursive: true, force: true }) }
})
