import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

export const POSTER_BINARY_RESOURCE = 'node_modules/ffmpeg-static/ffmpeg'
export const POSTER_RUNTIME_DIRECTORY = 'lib/captures/runtime'
export const POSTER_BINARY_ARCHIVE = `${POSTER_RUNTIME_DIRECTORY}/ffmpeg.gz`
export const POSTER_BINARY_MANIFEST = `${POSTER_RUNTIME_DIRECTORY}/ffmpeg.manifest.json`
export const POSTER_LICENSE_FILES = ['ffmpeg.README', 'ffmpeg.LICENSE', 'LICENSE', 'README.md']
export const POSTER_BINARY_MAX_BYTES = 128 * 1024 * 1024

const digest = () => createHash('sha256')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validSize = value => Number.isSafeInteger(value) && value > 0 && value <= POSTER_BINARY_MAX_BYTES

/** One extraction per process, shared by concurrent requests. The build owns
 * both paths and hashes; neither a request nor PATH can select an executable. */
export function createCapturePosterBinary({ root = process.cwd(), temporaryRoot = tmpdir() } = {}) {
  let pending
  async function prepare() {
    let encoded
    try { encoded = await readFile(join(root, POSTER_BINARY_MANIFEST), 'utf8') }
    catch (error) {
      // Development uses the same pinned package's native executable directly.
      if (error.code === 'ENOENT') return join(root, `${POSTER_BINARY_RESOURCE}${process.platform === 'win32' ? '.exe' : ''}`)
      throw error
    }
    const manifest = JSON.parse(encoded)
    if (!manifest || manifest.version !== 1 || !validSize(manifest.bytes) || !validSize(manifest.gzipBytes)
      || !validHash(manifest.sha256) || !validHash(manifest.gzipSha256)) throw new Error('capturePosterBinaryManifestInvalid')
    const directory = await mkdtemp(join(temporaryRoot, 'mikka-ffmpeg-'))
    try {
      const binary = join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
      const compressedHash = digest(), binaryHash = digest()
      let compressedBytes = 0, binaryBytes = 0
      const compressed = new Transform({ transform(chunk, _encoding, done) {
        compressedBytes += chunk.length
        if (compressedBytes > manifest.gzipBytes) return done(new Error('capturePosterBinarySizeExceeded'))
        compressedHash.update(chunk); done(null, chunk)
      } })
      const expanded = new Transform({ transform(chunk, _encoding, done) {
        binaryBytes += chunk.length
        if (binaryBytes > manifest.bytes) return done(new Error('capturePosterBinarySizeExceeded'))
        binaryHash.update(chunk); done(null, chunk)
      } })
      await pipeline(createReadStream(join(root, POSTER_BINARY_ARCHIVE)), compressed, createGunzip(), expanded,
        createWriteStream(binary, { flags: 'wx', mode: 0o600 }))
      if (compressedBytes !== manifest.gzipBytes || binaryBytes !== manifest.bytes
        || compressedHash.digest('hex') !== manifest.gzipSha256 || binaryHash.digest('hex') !== manifest.sha256)
        throw new Error('capturePosterBinaryChecksumMismatch')
      // Nothing executes before the exact build bytes are verified. mkdtemp's
      // private directory and this mode keep other users out of the executable.
      await chmod(binary, 0o500)
      return binary
    } catch (error) {
      try { await rm(directory, { recursive: true, force: true }) }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'capturePosterBinaryCleanupFailed') }
      throw error
    }
  }
  return () => {
    pending ??= prepare().catch(error => { pending = undefined; throw error })
    return pending
  }
}

export const capturePosterBinary = createCapturePosterBinary()
