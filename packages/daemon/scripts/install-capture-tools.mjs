// Adds the exact paired FFmpeg tools to Mikka's private runtime. Never touches
// an official file, system package, shared PATH entry or another release.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { CAPTURE_TOOLCHAIN, CAPTURE_TOOLS_ROOT } from '../src/agents/capture-video.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const execute = promisify(execFile)
const fail = code => { throw new Error(code) }

async function safeDirectory(path, ownerId) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== ownerId || (info.mode & 0o022) || await realpath(path) !== resolve(path)) fail('capture_tools_directory_unsafe')
}

async function download(asset) {
  const response = await fetch(`https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/${asset.assetId}`, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'Mikka-pinned-capture-tools' }, signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok || !response.body) fail('capture_tools_download_failed')
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > asset.downloadBytes) fail('capture_tools_download_size_mismatch')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Root/manifest/transport arguments isolate filesystem and network in tests;
 * the executable entry below accepts no paths, URLs, versions or digests. */
export async function installCaptureTools({ root = CAPTURE_TOOLS_ROOT, toolchain = CAPTURE_TOOLCHAIN,
  fetchAsset = download, ownerId = process.getuid?.() ?? 0 } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(toolchain.id) || Object.keys(toolchain.assets).sort().join(',') !== 'LICENSE,README,ffmpeg,ffprobe') fail('capture_tools_manifest_invalid')
  await safeDirectory(root, ownerId)
  const destination = join(root, toolchain.id)
  async function verify() {
    await safeDirectory(destination, ownerId)
    for (const [name, asset] of Object.entries(toolchain.assets)) {
      const path = join(destination, name), info = await lstat(path)
      if (!info.isFile() || info.uid !== ownerId || (info.mode & 0o022) || info.size !== asset.bytes
        || (['ffmpeg', 'ffprobe'].includes(name) && !(info.mode & 0o111))) fail('capture_tools_file_unsafe')
      if (digest(await readFile(path)) !== asset.sha256) fail('capture_tools_binary_hash_mismatch')
    }
  }
  const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing) { await verify(); return { directory: destination, cached: true, id: toolchain.id } }
  const staged = await mkdtemp(join(root, '.capture-tools-'))
  try {
    for (const [name, asset] of Object.entries(toolchain.assets)) {
      const compressed = await fetchAsset(asset)
      if (compressed.length !== asset.downloadBytes || digest(compressed) !== asset.downloadSha256) fail('capture_tools_download_hash_mismatch')
      const bytes = asset.gzip ? gunzipSync(compressed, { maxOutputLength: asset.bytes }) : compressed
      if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) fail('capture_tools_binary_hash_mismatch')
      const mode = ['ffmpeg', 'ffprobe'].includes(name) ? 0o555 : 0o444
      await writeFile(join(staged, name), bytes, { flag: 'wx', mode })
      // The worker runs as user, even if bootstrap inherited a private umask.
      await chmod(join(staged, name), mode)
    }
    await chmod(staged, 0o755)
    await rename(staged, destination)
    await verify()
    return { directory: destination, cached: false, id: toolchain.id }
  } finally { await rm(staged, { recursive: true, force: true }) }
}

if (process.argv[1] && basename(process.argv[1]) === 'install-capture-tools.mjs' && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2 || process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() !== 0) fail('capture_tools_install_target_refused')
    const receipt = await installCaptureTools()
    for (const binary of ['ffmpeg', 'ffprobe']) {
      const { stdout } = await execute(join(receipt.directory, binary), ['-version'], { timeout: 10_000, maxBuffer: 64 * 1024 })
      if (!stdout.startsWith(`${binary} version ${CAPTURE_TOOLCHAIN.version} `)) fail('capture_tools_version_mismatch')
    }
    process.stdout.write(`mikka-capture-tools-ready ${receipt.id}\n`)
  } catch (error) {
    process.stderr.write((/^capture_tools_[a-z_]+$/.test(error.message) ? error.message : 'capture_tools_install_failed') + '\n')
    process.exitCode = 1
  }
}
