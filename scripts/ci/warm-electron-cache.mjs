import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')

export function selectAssets(release, { version, platform, arch, checksums }) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.ok(platform === 'linux' && arch === 'x64' || platform === 'darwin' && arch === 'arm64')
  assert.equal(release.tag_name, `v${version}`)
  assert.equal(release.draft, false)
  const name = `electron-v${version}-${platform}-${arch}.zip`
  assert.match(checksums[name] ?? '', /^[a-f0-9]{64}$/)
  return [name, 'SHASUMS256.txt'].map(name => {
    const matches = release.assets.filter(asset => asset.name === name)
    assert.equal(matches.length, 1)
    const asset = matches[0]
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0)
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= (name.endsWith('.zip') ? 200_000_000 : 1_000_000))
    assert.equal(asset.state, 'uploaded')
    assert.equal(asset.browser_download_url, `https://github.com/electron/electron/releases/download/v${version}/${name}`)
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/)
    if (name.endsWith('.zip')) assert.equal(asset.digest, `sha256:${checksums[name]}`)
    return asset
  })
}

export function checksumEntry(text, name, expected) {
  const entries = text.split('\n').flatMap(line => {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    return match?.[2] === name ? [match[1].toLowerCase()] : []
  })
  assert.deepEqual(entries, [expected])
}

export async function warmCache({ fetchImpl = fetch, cacheRoot, platform = process.platform, arch = process.arch } = {}) {
  const packagePath = requireDesktop.resolve('electron/package.json')
  const { version } = JSON.parse(await readFile(packagePath, 'utf8'))
  const checksums = JSON.parse(await readFile(join(dirname(packagePath), 'checksums.json'), 'utf8'))
  const getRequire = createRequire(packagePath)
  // Locked Electron installations may resolve either the CJS or ESM get
  // package; both expose this same standard cache contract.
  const { Cache } = await import(pathToFileURL(join(dirname(getRequire.resolve('@electron/get')), 'Cache.js')).href)
  const cache = new Cache(cacheRoot)
  const directory = await mkdtemp(join(tmpdir(), 'mikka-electron-assets-'))
  // Bounded retries of public GitHub downloads, never application/DB polling.
  const request = async (url, accept, api = true) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const headers = { Accept: accept, 'User-Agent': 'Mikka-Electron-cache' }
        if (api && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
        const response = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(120_000) })
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await response.body?.cancel(); await delay((attempt + 1) * 1000); continue
        }
        return response
      } catch (error) {
        if (attempt === 2) throw new Error('ELECTRON_ASSET_NETWORK', { cause: error })
        await delay((attempt + 1) * 1000)
      }
    }
  }
  try {
    const response = await request(`https://api.github.com/repos/electron/electron/releases/tags/v${version}`, 'application/vnd.github+json')
    assert.equal(response.status, 200)
    const [archive, sums] = selectAssets(await response.json(), { version, platform, arch, checksums })
    const download = async asset => {
      let response = await request(`https://api.github.com/repos/electron/electron/releases/assets/${asset.id}`, 'application/octet-stream')
      if (response.status === 302) {
        const target = new URL(response.headers.get('location'))
        assert.equal(target.protocol, 'https:'); assert.equal(target.hostname, 'release-assets.githubusercontent.com')
        assert.ok(!target.username && !target.password && !target.port)
        await response.body?.cancel()
        // Never forward the repository credential to a signed download URL.
        response = await request(target.href, 'application/octet-stream', false)
      }
      assert.equal(response.status, 200)
      const contentType = response.headers.get('content-type')?.split(';')[0]
      assert.ok(contentType === 'application/octet-stream' || asset.name === 'SHASUMS256.txt' && contentType === 'text/plain')
      const file = join(directory, asset.name), handle = await open(file, 'wx'), digest = createHash('sha256')
      let bytes = 0
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length; assert.ok(bytes <= asset.size)
          digest.update(chunk); await handle.writeFile(chunk)
        }
      } finally { await handle.close() }
      assert.equal(bytes, asset.size); assert.equal(`sha256:${digest.digest('hex')}`, asset.digest)
      return file
    }
    const sumsFile = await download(sums), text = await readFile(sumsFile, 'utf8')
    checksumEntry(text, archive.name, checksums[archive.name])
    const archiveFile = await download(archive)
    await cache.putFileInCache(archive.browser_download_url, archiveFile, archive.name)
    // electron-builder's documented seeded-checksum contract keeps validation
    // enabled without @electron/get's otherwise unconditional SHASUMS fetch.
    await writeFile(join(cache.cacheRoot, `SHASUMS256.txt-${version}`), text)
    return { version, platform, arch, bytes: archive.size, sha256: checksums[archive.name], standardCacheSeeded: true, checksumFileSha256: hash(text) }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  warmCache().then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    // Do not expose redirect signatures, headers, response bodies or env values.
    console.error(JSON.stringify({ failure: error.code === 'ERR_ASSERTION' ? 'ELECTRON_ASSET_INVALID' : 'ELECTRON_ASSET_FAILED' }))
    process.exitCode = 1
  })
}
