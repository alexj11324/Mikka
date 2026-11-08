import { createWriteStream } from 'node:fs'
import { realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

function need(value, code) {
  if (!value) throw Object.assign(new Error(code), { code })
}

// Use GitHub's official asset API when the release-page download edge is down.
// @electron/get still verifies the package's locked checksum and owns its cache.
export async function downloadOfficialAsset({ version, filename, checksum, destination, token,
  platform = 'linux', arch = 'x64', fetchImpl = fetch }) {
  need(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'ELECTRON_VERSION_INVALID')
  need(['linux/x64', 'darwin/arm64'].includes(`${platform}/${arch}`), 'ELECTRON_CI_PLATFORM_INVALID')
  need(filename === `electron-v${version}-${platform}-${arch}.zip`, 'ELECTRON_FILENAME_INVALID')
  need(/^[a-f0-9]{64}$/.test(checksum ?? ''), 'ELECTRON_CHECKSUM_INVALID')
  const api = 'https://api.github.com/repos/electron/electron'
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  const releaseResponse = await fetchImpl(`${api}/releases/tags/v${version}`, {
    headers, redirect: 'error', signal: AbortSignal.timeout(30000),
  })
  need(releaseResponse.ok, 'ELECTRON_RELEASE_HTTP')
  const release = await releaseResponse.json()
  need(Array.isArray(release.assets), 'ELECTRON_ASSET_LIST_INVALID')
  const matches = release.assets.filter(asset => asset.name === filename)
  need(matches.length === 1, 'ELECTRON_ASSET_NOT_UNIQUE')
  const asset = matches[0]
  need(asset.state === 'uploaded', 'ELECTRON_ASSET_NOT_READY')
  need(asset.digest === `sha256:${checksum}`, 'ELECTRON_ASSET_DIGEST_MISMATCH')
  need(Number.isSafeInteger(asset.id) && asset.id > 0, 'ELECTRON_ASSET_ID_INVALID')
  let response = await fetchImpl(`${api}/releases/assets/${asset.id}`, {
    headers: { ...headers, accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(120000),
  })
  if (response.status === 302) {
    const location = new URL(response.headers.get('location'))
    need(location.protocol === 'https:' && location.hostname === 'release-assets.githubusercontent.com'
      && !location.port && !location.username && !location.password && !location.hash, 'ELECTRON_ASSET_REDIRECT_INVALID')
    await response.body?.cancel()
    // Never forward the GitHub token to the signed CDN URL or print that URL.
    response = await fetchImpl(location.href, { redirect: 'error', signal: AbortSignal.timeout(120000) })
  }
  need(response.ok && response.body, 'ELECTRON_ASSET_HTTP')
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }))
}

export async function seedBuilderChecksum(archive, version, filename, checksum) {
  need(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'ELECTRON_VERSION_INVALID')
  need(basename(archive) === filename && /^[a-f0-9]{64}$/.test(checksum ?? ''), 'ELECTRON_CACHE_IDENTITY_INVALID')
  // ReadWrite @electron/get returns <cache root>/<URL hash>/<archive>.
  // electron-builder's documented seed keeps checksum validation enabled on
  // cache hits, instead of fetching SHASUMS256.txt from the failed release edge.
  await writeFile(join(dirname(dirname(archive)), `SHASUMS256.txt-${version}`), `${checksum} *${filename}\n`, { mode: 0o600 })
}

async function install() {
  const platform = process.platform, arch = process.arch
  need(['linux/x64', 'darwin/arm64'].includes(`${platform}/${arch}`), 'ELECTRON_CI_PLATFORM_INVALID')
  const require = createRequire(new URL('../package.json', import.meta.url))
  const packageFile = await realpath(require.resolve('electron/package.json'))
  const electron = createRequire(packageFile)
  const { version } = electron('./package.json'), checksums = electron('./checksums.json')
  const filename = `electron-v${version}-${platform}-${arch}.zip`
  const { downloadArtifact, ElectronDownloadCacheMode } = electron('@electron/get')
  let downloadedViaApi = false
  const archive = await downloadArtifact({ version, artifactName: 'electron', platform, arch, checksums,
    cacheMode: ElectronDownloadCacheMode.ReadWrite,
    cacheRoot: process.env.electron_config_cache,
    downloader: { async download(url, destination) {
      need(url === `https://github.com/electron/electron/releases/download/v${version}/${filename}`, 'ELECTRON_SOURCE_INVALID')
      await downloadOfficialAsset({ version, filename, platform, arch, checksum: checksums[filename], destination, token: process.env.GITHUB_TOKEN })
      downloadedViaApi = true
    } },
  })
  await seedBuilderChecksum(archive, version, filename, checksums[filename])
  const installerEnv = { ...process.env }
  delete installerEnv.GITHUB_TOKEN
  try { await promisify(execFile)(process.execPath, [join(dirname(packageFile), 'install.js')], { timeout: 120000, env: installerEnv }) }
  catch (cause) { throw Object.assign(new Error('ELECTRON_INSTALL_FAILED', { cause }), { code: 'ELECTRON_INSTALL_FAILED' }) }
  console.log(JSON.stringify({ event: 'electron_pinned_install', version, platform, arch,
    sha256: checksums[filename], downloadedViaApi, builderChecksumSeeded: true }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await install().catch(error => {
    console.error(JSON.stringify({ event: 'electron_pinned_install_failed', code: /^ELECTRON_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'ELECTRON_SETUP_FAILED' }))
    process.exitCode = 1
  })
}
