import assert from 'node:assert/strict'
import test from 'node:test'
import { checksumEntry, selectAssets } from './warm-electron-cache.mjs'

const checksum = 'a'.repeat(64), version = '45.1.0'
function fixture(platform = 'linux', arch = 'x64') {
  const name = `electron-v${version}-${platform}-${arch}.zip`
  const options = { version, platform, arch, checksums: { [name]: checksum } }
  const release = { tag_name: `v${version}`, draft: false, assets: [name, 'SHASUMS256.txt'].map((name, index) => ({
    id: index + 1, name, size: index ? 6740 : 123917468, state: 'uploaded', digest: `sha256:${checksum}`,
    browser_download_url: `https://github.com/electron/electron/releases/download/v${version}/${name}`,
  })) }
  return { name, options, release }
}

test('uses exactly the locked version and official host for both desktop runner platforms', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64']]) {
    const { release, options, name } = fixture(platform, arch)
    assert.deepEqual(selectAssets(release, options).map(asset => asset.name), [name, 'SHASUMS256.txt'])
  }
})

test('rejects substituted release, duplicate assets, wrong host, oversized files and a digest outside the npm pin', () => {
  const mutations = [
    r => { r.tag_name = 'v45.2.0' }, r => { r.draft = true },
    r => { r.assets.push(r.assets[0]) }, r => { r.assets.pop() },
    r => { r.assets[0].browser_download_url = 'https://example.com/electron.zip' },
    r => { r.assets[0].digest = `sha256:${'b'.repeat(64)}` },
    r => { r.assets[0].size = 200_000_001 }, r => { r.assets[1].size = 1_000_001 },
    r => { r.assets[0].id = '../credentials' }, r => { r.assets[0].state = 'new' },
  ]
  for (const mutate of mutations) {
    const { release, options } = fixture(); mutate(release)
    assert.throws(() => selectAssets(release, options))
  }
  const { release, options } = fixture()
  assert.throws(() => selectAssets(release, { ...options, arch: 'arm64' }))
  assert.throws(() => selectAssets(release, { ...options, version: '../other' }))
})

test('upstream checksum formats must name the exact artifact once with the pinned npm digest', () => {
  const { name } = fixture()
  for (const separator of ['  ', ' *']) checksumEntry(`${checksum}${separator}${name}\n`, name, checksum)
  for (const text of ['', `${'b'.repeat(64)}  ${name}`, `${checksum}  other.zip`,
    `${checksum}  ${name}\n${checksum}  ${name}`]) assert.throws(() => checksumEntry(text, name, checksum))
})
