/** Private files in one disposable candidate VM. No server permission or
 * credential is accepted from the non-secret hint projection. */
import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync, readSync, watch } from 'node:fs'
import { link, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { openDeviceGateway, runDeviceGateway, type DeviceGatewaySocket } from '../../packages/daemon/src/device-gateway.ts'
import type { ServerLink } from '../../packages/daemon/src/server-link.ts'
import { anonymousClaudeHintSchema } from '../../packages/protocol/src/claude-startup.ts'
import { anonymousCodexHintSchema } from '../../packages/protocol/src/codex-startup.ts'

// Only the daemon workspace is installed in the exact template checkout.
// Resolve its declared dependency instead of requiring root dev dependencies.
const { z }: typeof import('zod') = createRequire(new URL('../../packages/daemon/package.json', import.meta.url))('zod')
const projection = z.object({
  version: z.literal(1), authority: z.literal('none'), deviceId: z.uuid(), workspaceId: z.uuid(),
  harness: z.enum(['claude_code', 'codex']), hint: z.unknown(),
}).strict()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function readCandidateStart(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536)
      throw Error('candidate_bootstrap_file_invalid')
    const bytes = Buffer.alloc(65537), count = readSync(fd, bytes, 0, bytes.length, 0)
    if (count !== stat.size || count > 65536) throw Error('candidate_bootstrap_file_invalid')
    return JSON.parse(bytes.subarray(0, count).toString('utf8')) as unknown
  } finally { closeSync(fd) }
}

/** Watch before the initial read: a publish on either side of watcher creation
 * is observed once, with no polling or directory scan. */
export function waitForCandidateStart(path: string, signal: AbortSignal, timeoutMs = 240000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error: unknown, value?: unknown) => {
      if (done) return
      done = true; watcher.close(); clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve(value)
    }
    const read = () => {
      try { finish(null, readCandidateStart(path)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error) }
    }
    const watcher = watch(dirname(path), (_event, name) => { if (String(name) === basename(path)) read() })
    watcher.on('error', error => finish(error))
    const timer = setTimeout(() => finish(Error('candidate_bootstrap_timeout')), timeoutMs)
    const abort = () => finish(signal.reason ?? Error('candidate_bootstrap_cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort(); else read()
  })
}

export async function publishCandidateBootstrap(directory: string, bootstrap: string, raw: unknown, harness: 'claude_code' | 'codex', signal?: AbortSignal) {
  signal?.throwIfAborted()
  const projected = projection.parse(raw)
  const config = JSON.parse(bootstrap) as { deviceId?: unknown; workspaceId?: unknown; collectCliTiming?: unknown }
  const hint = (harness === 'claude_code' ? anonymousClaudeHintSchema : anonymousCodexHintSchema).parse(projected.hint)
  if (projected.harness !== harness || projected.deviceId !== config.deviceId || projected.workspaceId !== config.workspaceId ||
    config.collectCliTiming !== true || hint.diagnostics !== true || hint.bootstrapSha256 !== digest(bootstrap))
    throw Error('candidate_bootstrap_binding_invalid')
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw Error('candidate_bootstrap_directory_invalid')
  const hintName = harness === 'claude_code' ? 'anonymous-claude.json' : 'anonymous-codex.json'
  const payloads = [
    ['initial-run.json', JSON.stringify({ version: 1, runId: hint.runId, bootstrapSha256: hint.bootstrapSha256 })],
    [hintName, JSON.stringify(hint)],
    ['bootstrap.json', bootstrap],
  ] as const
  for (const name of ['initial-run.json', 'anonymous-claude.json', 'anonymous-codex.json', 'bootstrap.json']) {
    if (existsSync(join(directory, name)) || existsSync(join(directory, name + '.candidate-next')))
      throw Error('candidate_bootstrap_already_present')
  }
  const written: string[] = []
  try {
    for (const [name, data] of payloads) {
      signal?.throwIfAborted()
      const path = join(directory, name + '.candidate-next')
      await writeFile(path, data, { mode: 0o600, flag: 'wx' }); written.push(path)
    }
    // These are the production decoder's real paths. The credential handoff
    // becomes visible last; the existing preloaded worker owns the only claim.
    for (const [name] of payloads) {
      signal?.throwIfAborted()
      // link is atomic and refuses an existing destination; this acceptance
      // handoff must never rotate or replace a previously installed identity.
      await link(join(directory, name + '.candidate-next'), join(directory, name))
    }
  } finally {
    await Promise.all(written.map(path => unlink(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })))
  }
  return { version: 1 as const, runId: hint.runId, harness, bootstrapSha256: hint.bootstrapSha256,
    hintSha256: digest(JSON.stringify(hint)) }
}

/** The normal authenticated push socket preserves device availability while the
 * Coordinator queues the case. Work hints grant no authority and cannot start a
 * task here; only the real worker consumes the later bootstrap and claims it. */
export async function holdCandidateRegistration(link: Pick<ServerLink, 'deviceGateway'>, deviceId: string,
  signal: AbortSignal, connect: (url: string, protocol: string) => DeviceGatewaySocket = openDeviceGateway) {
  const lifetime = new AbortController(), joined = AbortSignal.any([signal, lifetime.signal])
  const ticket = await link.deviceGateway?.(deviceId, joined)
  if (!ticket?.url || !ticket.protocol) throw Error('candidate_gateway_unavailable')
  joined.throwIfAborted()
  let ready!: () => void, failed!: (error: unknown) => void
  const opened = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  const running = runDeviceGateway(connect(ticket.url, ticket.protocol), {
    signal: joined, onOpen: ready, onWork: async () => { /* no dispatch/claim before bootstrap */ },
  })
  const finished = running.then(() => {
    if (!joined.aborted) lifetime.abort(Error('candidate_gateway_closed'))
    failed(joined.reason ?? Error('candidate_gateway_closed'))
  }, error => { lifetime.abort(Error('candidate_gateway_failed', { cause: error })); failed(lifetime.signal.reason) })
  await opened
  return { signal: joined, close: async () => { lifetime.abort(); await finished } }
}
