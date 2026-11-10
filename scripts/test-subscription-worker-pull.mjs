// Acquisition may retry a registry transport failure. Container execution and
// the worker/application tests remain single attempts in the caller.
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export const BYOS_IMAGES = Object.freeze({
  postgres: 'postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb',
  golang: 'golang:1.26.10-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af',
})
const retryDelays = Object.freeze([1000, 3000])
const transient = new Set(['registry_http_429', 'registry_http_502', 'registry_http_503', 'registry_timeout'])

/** Unknown, authorization, integrity and local-daemon failures fail closed. */
export function registryPullFailure(stderr) {
  if (/unauthorized|authentication required|denied|manifest unknown|manifest not found|no matching manifest|invalid reference|invalid tag|unexpected (?:commit )?digest|digest[^\n]*(?:mismatch|does not match|invalid|expected)|checksum[^\n]*(?:mismatch|does not match|invalid|expected)|verification failed|x509|certificate|cannot connect to the docker daemon|error during connect|unsupported media type/i.test(stderr)) return 'permanent'
  const status = /unexpected (?:HTTP )?status[^\n]{0,1024}\b(429|502|503)\b/i.exec(stderr)?.[1]
  if (status) return `registry_http_${status}`
  if (/\btoomanyrequests:|\b429 Too Many Requests\b/i.test(stderr)) return 'registry_http_429'
  if (/(?:net\/http:|(?:Get|Head|Post) "https:\/\/|dial tcp )[^\n]{0,2048}(?:TLS handshake timeout|i\/o timeout|Client\.Timeout exceeded|context deadline exceeded)/i.test(stderr)) return 'registry_timeout'
  return 'unknown'
}

class ImagePullError extends Error {
  constructor(detail, exitCode, options) {
    super('BYOS_IMAGE_PULL_FAILED', options)
    this.name = 'ImagePullError'; this.code = 'BYOS_IMAGE_PULL_FAILED'
    this.detail = detail; this.exitCode = exitCode
  }
}

function pull(image, { env, spawnImpl, stderr }) {
  return new Promise((resolve, reject) => {
    let captured = '', overflow = false
    const child = spawnImpl('docker', ['pull', image], { env, stdio: ['ignore', 'inherit', 'pipe'] })
    child.stderr.on('data', chunk => {
      stderr.write(chunk) // Preserve the original registry diagnostic, including on a recovered pull.
      if (captured.length + chunk.length <= 64 * 1024) captured += chunk.toString()
      else overflow = true
    })
    child.on('error', error => reject(new ImagePullError('spawn', null, { cause: error })))
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) resolve()
      else reject(new ImagePullError(signal ? 'interrupted' : overflow ? 'unknown' : registryPullFailure(captured), code))
    })
  })
}

export async function pullPinnedByosImage(image, {
  env = { PATH: process.env.PATH, LANG: 'C.UTF-8' }, spawnImpl = spawn, sleep = delay, stderr = process.stderr,
} = {}) {
  if (!Object.values(BYOS_IMAGES).includes(image)) throw new ImagePullError('unpinned_image', null)
  for (let attempt = 0; ; attempt++) {
    try { await pull(image, { env, spawnImpl, stderr }); return }
    catch (error) {
      if (!(error instanceof ImagePullError) || !transient.has(error.detail) || attempt >= retryDelays.length) throw error
      const wait = retryDelays[attempt]
      stderr.write(`BYOS image setup: ${error.detail}; acquisition attempt ${attempt + 2}/3 after ${wait}ms\n`)
      await sleep(wait)
    }
  }
}
