import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostedCliManifest } from './hosted-binaries'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 768 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const BUDGET_MS = 10_000

export interface HostedCliPrefetch {
  done: Promise<{ status: 'complete' | 'partial' | 'aborted'; files: number; bytes: number }>
  abort(): void
}

async function packageJson(path: string, signal: AbortSignal): Promise<{ name?: unknown; bin?: unknown }> {
  signal.throwIfAborted()
  const file = await open(path, READ_FLAGS)
  try {
    signal.throwIfAborted()
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 8192) throw Error('CLI package metadata unavailable')
    const buffer = Buffer.alloc(8193)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    signal.throwIfAborted()
    if (bytesRead !== stat.size) throw Error('CLI package metadata changed')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await file.close() }
}

/** Follow the installed official launcher's package selection, without loading
 * or executing its JavaScript. Validated against the official 0.166.0 launcher,
 * codex-cli/bin/codex.js at openai/codex 6ff1e1ca; its optional platform package
 * wins over the same-install vendor fallback. Unknown layouts stay optional. */
async function codexNativeFile(launcher: string, signal: AbortSignal): Promise<string | undefined> {
  if (basename(launcher) !== 'codex.js' || basename(dirname(launcher)) !== 'bin') return undefined
  const root = dirname(dirname(launcher))
  const pkg = await packageJson(join(root, 'package.json'), signal)
  const entry = typeof pkg.bin === 'string' ? pkg.bin
    : pkg.bin && typeof pkg.bin === 'object' && 'codex' in pkg.bin ? pkg.bin.codex : undefined
  if (pkg.name !== '@openai/codex' || entry !== 'bin/codex.js') throw Error('CLI package selection unavailable')
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined
  const os = process.platform === 'linux' || process.platform === 'android' ? 'linux'
    : process.platform === 'darwin' || process.platform === 'win32' ? process.platform : undefined
  if (!arch || !os) throw Error('CLI platform unavailable')
  const triple = `${arch}-${os === 'linux' ? 'unknown-linux-musl' : os === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc'}`
  const name = `@openai/codex-${os}-${process.arch}`
  let installed: string | undefined
  try { installed = createRequire(pathToFileURL(launcher)).resolve(`${name}/package.json`) }
  catch { /* The official launcher uses its own vendor directory in this case. */ }
  signal.throwIfAborted()
  if (installed && (await packageJson(installed, signal)).name !== name) throw Error('CLI platform package unavailable')
  const native = join(installed ? dirname(installed) : root, 'vendor', triple, 'bin', os === 'win32' ? 'codex.exe' : 'codex')
  // Do not turn an optional prefetch into an unrelated file read via a link.
  if (await realpath(native) !== native) throw Error('CLI platform file unavailable')
  return native
}

/** One bounded, asynchronous pass over resolver-selected software after a
 * cloud bootstrap. Registration/claim never await it. Nothing is executed,
 * no HOME/config/credential is inspected, and no bytes or paths are logged.
 * Counts describe local reads only, never a model or execution receipt. */
export function prefetchHostedCliFiles(binaries: Partial<Record<'claude_code' | 'codex', string>>, kind?: HostedCliManifest['kind']): HostedCliPrefetch {
  const abort = new AbortController(), signal = abort.signal
  const timer = setTimeout(() => abort.abort(), BUDGET_MS)
  timer.unref()
  const done = Promise.resolve().then(async () => {
    const buffer = Buffer.alloc(CHUNK_BYTES), seen = new Set<string>()
    let files = 0, bytes = 0, partial = false
    const read = async (path: string) => {
      signal.throwIfAborted()
      if (seen.has(path)) return
      seen.add(path)
      const file = await open(path, READ_FLAGS)
      try {
        signal.throwIfAborted()
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_TOTAL_BYTES)
          throw Error('CLI prefetch size unavailable')
        let position = 0
        while (position < stat.size) {
          signal.throwIfAborted()
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position)
          bytes += bytesRead
          signal.throwIfAborted()
          if (!bytesRead) throw Error('CLI prefetch file changed')
          position += bytesRead
        }
        files++
      } finally { await file.close() }
    }
    const harnesses = kind === 'claude' ? ['claude_code'] as const : kind === 'codex' ? ['codex'] as const : ['claude_code', 'codex'] as const
    for (const harness of harnesses) {
      const binary = binaries[harness]
      if (!binary || signal.aborted) continue
      try {
        await read(binary)
        if (harness === 'codex') {
          const native = await codexNativeFile(binary, signal)
          if (native) await read(native)
        }
      } catch { partial = true } // This optimization must not replace normal CLI errors or validation.
    }
    return { status: signal.aborted ? 'aborted' as const : partial ? 'partial' as const : 'complete' as const, files, bytes }
  }).finally(() => clearTimeout(timer))
  return { done, abort: () => abort.abort() }
}
