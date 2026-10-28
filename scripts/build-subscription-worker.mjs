// Opt-in remote deployment build. The pinned compiler and CPA source are
// verified independently; no platform secrets are inherited by the compiler.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.MIKKA_BUILD_BYOS_WORKER === '1') {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Subscription worker requires Linux x64')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const worker = join(root, 'packages/subscription-worker')
  const scratch = mkdtempSync(join(tmpdir(), 'mikka-byos-build-'))
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOCACHE: join(scratch, 'build-cache'), GOPATH: join(scratch, 'gopath') }
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key]
  try {
    const response = await fetch('https://go.dev/dl/go1.26.10.linux-amd64.tar.gz', { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error('Go compiler download failed')
    const archive = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(archive).digest('hex') !== 'ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5') throw new Error('Go compiler checksum mismatch')
    const archivePath = join(scratch, 'go.tar.gz')
    writeFileSync(archivePath, archive, { mode: 0o600 })
    execFileSync('tar', ['-xzf', archivePath, '-C', scratch], { env, stdio: 'inherit' })
    execFileSync(process.execPath, ['packages/subscription-worker/bootstrap.mjs'], { cwd: root, env, stdio: 'inherit' })
    mkdirSync(join(worker, 'bin'), { recursive: true })
    for (const name of ['mikka-subscription-worker', 'mikka-subscription-enrollment']) {
      execFileSync(join(scratch, 'go/bin/go'), ['build', '-mod=readonly', '-trimpath', '-o', `bin/${name}`, `./cmd/${name}`], { cwd: worker, env, stdio: 'inherit' })
    }
  } finally {
    console.error(`Retained subscription worker build files: ${scratch}`)
  }
}
