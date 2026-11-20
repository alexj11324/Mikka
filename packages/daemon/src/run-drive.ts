// Mirrors a run's shared Drive folders to `~/.mikka/drive/<scope>/<scopeId>/`
// (decision 2026-11-19-2200 §4). It is a client of the run's existing MCP
// endpoint and bearer, like the run mailbox: the server decides which folders
// the run may read or write, and every write is Drive's compare-and-swap.
// Pull before the agent starts; push after a checkpoint and at the end. A
// write that loses to a newer remote version never overwrites it: the local
// version is kept beside it as `<name>.conflict-<run><ext>`.
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { RunAssignment } from '@mikka/protocol'
import { trustedServerEndpoint } from './trusted-endpoint'

const READ_LIMIT = 1024 * 1024
const WRITE_LIMIT = 4 * 1024 * 1024
const MAX_FILES = 2000
const STATE_DIR = '.state'

const scopeSchema = z.object({ scope: z.enum(['bot', 'thread', 'environment', 'workspace']), scopeId: z.uuid(), write: z.boolean() }).strict()
const listingSchema = z.object({
  volume: z.object({ id: z.string(), headDigest: z.string(), entries: z.array(z.object({ path: z.string(), sizeBytes: z.number(), sha256: z.string() })) }).nullable(),
}).passthrough()
const stateSchema = z.object({ volumeId: z.string().nullable(), headDigest: z.string().nullable(), files: z.record(z.string(), z.string()) }).strict()
type DriveSyncScope = z.infer<typeof scopeSchema>
type ScopeState = z.infer<typeof stateSchema>

export interface RunDrive {
  /** The local folders, for the agent's brief. */
  folders: readonly { scope: string; path: string; write: boolean }[]
  pull(): Promise<void>
  push(): Promise<void>
}

export type DriveCall = (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; value: Record<string, unknown> }>

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** A Drive path inside its folder, or null: never `..`, absolute or a separator escape. */
export function localDrivePath(folder: string, path: string): string | null {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return null
  const target = resolve(folder, ...path.split('/'))
  return target.startsWith(resolve(folder) + sep) ? target : null
}

/** `notes/plan.md` → `notes/plan.conflict-1a2b3c4d.md` */
export function conflictPath(path: string, runId: string): string {
  const ext = extname(path)
  return `${ext ? path.slice(0, -ext.length) : path}.conflict-${runId.slice(0, 8)}${ext}`
}

async function walk(folder: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (found.length >= MAX_FILES) return
      const full = join(dir, entry.name)
      // Links are never followed or uploaded: they could name files outside the folder.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) found.push(relative(folder, full).split(sep).join('/'))
    }
  }
  await visit(folder).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  return found
}

/** The pure sync engine; `call` is the run's MCP tool call. */
export function createDriveMirror(options: { root: string; runId: string; scopes: readonly DriveSyncScope[]; call: DriveCall; warn?: (message: string, detail?: unknown) => void }): RunDrive {
  const { root, runId, call } = options
  const warn = options.warn ?? (() => {})
  const folderOf = (scope: DriveSyncScope) => join(root, scope.scope, scope.scopeId)
  const stateFile = (scope: DriveSyncScope) => join(root, STATE_DIR, `${scope.scope}-${scope.scopeId}.json`)
  const target = (scope: DriveSyncScope) => ({ scope: scope.scope, scopeId: scope.scopeId })
  const readState = async (scope: DriveSyncScope): Promise<ScopeState> => {
    try { return stateSchema.parse(JSON.parse(await readFile(stateFile(scope), 'utf8'))) } catch { return { volumeId: null, headDigest: null, files: {} } }
  }
  const saveState = async (scope: DriveSyncScope, state: ScopeState) => {
    await mkdir(join(root, STATE_DIR), { recursive: true, mode: 0o700 })
    await writeFile(stateFile(scope), JSON.stringify(state), { mode: 0o600 })
  }
  const list = async (scope: DriveSyncScope, volumeId?: string | null) => {
    const result = await call('drive_list', { ...target(scope), ...(volumeId ? { volumeId } : {}) })
    if (result.isError) throw new Error(`drive_list ${String(result.value.error ?? 'failed')}`)
    return listingSchema.parse(result.value).volume
  }
  const download = async (scope: DriveSyncScope, volumeId: string, path: string, file: string, expected: string) => {
    const result = await call('drive_read', { ...target(scope), volumeId, path, encoding: 'base64' })
    if (result.isError || typeof result.value.content !== 'string') throw new Error(`drive_read ${String(result.value.error ?? 'failed')}`)
    const bytes = Buffer.from(result.value.content, 'base64')
    if (sha(bytes) !== expected) throw new Error('drive_read digest mismatch')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }

  async function pullScope(scope: DriveSyncScope) {
    const folder = folderOf(scope)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const previous = await readState(scope)
    const volume = await list(scope)
    const state: ScopeState = { volumeId: volume?.id ?? null, headDigest: volume?.headDigest ?? null, files: {} }
    const remote = new Set<string>()
    for (const entry of volume?.entries ?? []) {
      const file = localDrivePath(folder, entry.path)
      if (!file) continue
      remote.add(entry.path)
      // Larger files stay a Drive-only surface; they are never mirrored, so never deleted by a push.
      if (entry.sizeBytes > READ_LIMIT) continue
      let local: string | null = null
      try { local = sha(await readFile(file)) } catch { /* absent */ }
      if (local !== entry.sha256) await download(scope, volume!.id, entry.path, file, entry.sha256)
      state.files[entry.path] = entry.sha256
    }
    // A file this mirror pulled before and Drive no longer has was deleted there.
    for (const path of Object.keys(previous.files)) {
      if (remote.has(path)) continue
      const file = localDrivePath(folder, path)
      if (file) await rm(file, { force: true })
    }
    await saveState(scope, state)
  }

  async function write(scope: DriveSyncScope, state: ScopeState, path: string, bytes: Buffer | null): Promise<'ok' | 'conflict'> {
    const content = bytes === null ? {} : { content: bytes.toString('base64'), encoding: 'base64' }
    const fingerprint = sha(`${path}\0${bytes === null ? 'delete' : sha(bytes)}`).slice(0, 32)
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await call('drive_write', { ...target(scope), ...(state.volumeId ? { volumeId: state.volumeId } : {}), path, ...content,
        expectedDigest: state.headDigest ?? '0'.repeat(64), mutationId: `sync:${runId}:${fingerprint}:${attempt}` })
      if (!result.isError) {
        state.volumeId = String(result.value.volumeId)
        state.headDigest = String(result.value.headDigest)
        return 'ok'
      }
      if (result.value.error !== 'interop_drive_conflict') throw new Error(`drive_write ${String(result.value.error ?? 'failed')}`)
      // The folder moved. Retry only if this path itself is still what this mirror last saw.
      const volume = await list(scope, state.volumeId)
      state.volumeId = volume?.id ?? state.volumeId
      state.headDigest = volume?.headDigest ?? (typeof result.value.headDigest === 'string' ? result.value.headDigest : state.headDigest)
      const remoteSha = volume?.entries.find(entry => entry.path === path)?.sha256 ?? null
      if (remoteSha !== (state.files[path] ?? null)) return 'conflict'
    }
    return 'conflict'
  }

  async function pushScope(scope: DriveSyncScope) {
    if (!scope.write) return
    const folder = folderOf(scope)
    const state = await readState(scope)
    const local = new Map<string, Buffer>()
    for (const path of await walk(folder)) {
      const file = localDrivePath(folder, path)
      if (!file || (await lstat(file)).size > WRITE_LIMIT) continue
      local.set(path, await readFile(file))
    }
    const changes: { path: string; bytes: Buffer | null }[] = []
    for (const [path, bytes] of local) if (state.files[path] !== sha(bytes)) changes.push({ path, bytes })
    for (const path of Object.keys(state.files)) if (!local.has(path)) changes.push({ path, bytes: null })
    if (!changes.length) return
    let conflicted = false
    for (const change of changes) {
      const outcome = await write(scope, state, change.path, change.bytes)
      if (outcome === 'ok') {
        if (change.bytes === null) delete state.files[change.path]
        else state.files[change.path] = sha(change.bytes)
        continue
      }
      conflicted = true
      // The newer remote version wins the path; ours is kept beside it.
      if (change.bytes !== null) {
        const copy = conflictPath(change.path, runId)
        if (await write(scope, state, copy, change.bytes) === 'ok') state.files[copy] = sha(change.bytes)
        warn('drive sync conflict kept as a copy', { scope: scope.scope, path: change.path })
      }
    }
    await saveState(scope, state)
    // Bring the remote winners (and the copies) back to this machine.
    if (conflicted) await pullScope(scope)
  }

  const each = async (work: (scope: DriveSyncScope) => Promise<void>, label: string) => {
    for (const scope of options.scopes) {
      try { await work(scope) } catch (error) { warn(`drive ${label} failed`, { scope: scope.scope, error: error instanceof Error ? error.name : 'Error' }) }
    }
  }
  let pushing: Promise<void> | undefined
  return {
    folders: options.scopes.map(scope => ({ scope: scope.scope, path: folderOf(scope), write: scope.write })),
    pull: () => each(pullScope, 'pull'),
    // Pushes never overlap: a checkpoint and the terminal push run one after the other.
    push: () => (pushing = (pushing ?? Promise.resolve()).then(() => each(pushScope, 'push'))),
  }
}

/** The run's Drive mirror over its MCP endpoint, or undefined when the run has none. */
export async function createRunDrive(host: {
  assignment: RunAssignment
  endpoint: URL
  root: string
  fetch: typeof fetch
  signal: AbortSignal
  headers?: Record<string, string>
  warn?: (message: string, detail?: unknown) => void
}): Promise<RunDrive | undefined> {
  const assigned = host.assignment.mcp
  if (!assigned) return undefined
  let endpoint: URL
  try { endpoint = new URL(assigned.url) } catch { return undefined }
  if (endpoint.href !== host.endpoint.href || !trustedServerEndpoint(endpoint) || !/^mkw_[A-Za-z0-9_-]{43}$/.test(assigned.token)) return undefined
  let nextId = 0, session: string | null = null, version = '2025-03-26'
  const rpc = async (method: string, params: unknown, notification = false) => {
    const id = ++nextId
    const response = await host.fetch(endpoint, { method: 'POST', redirect: 'error',
      headers: { ...host.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${assigned.token}`,
        'MCP-Protocol-Version': version, ...(session ? { 'Mcp-Session-Id': session } : {}) },
      signal: AbortSignal.any([host.signal, AbortSignal.timeout(30_000)]),
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params }) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`drive rpc ${response.status}`) }
    const sid = response.headers.get('mcp-session-id')
    if (sid && sid.length <= 256 && !/[\r\n]/.test(sid)) session = sid
    if (notification) { await response.body?.cancel(); return null }
    const text = await response.text()
    if (text.length > 8 * 1024 * 1024) throw new Error('drive rpc too large')
    const packet = response.headers.get('content-type')?.split(';')[0] === 'text/event-stream'
      ? JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5) ?? 'null') : JSON.parse(text)
    if (packet?.jsonrpc !== '2.0' || packet.id !== id || packet.error || !packet.result) throw new Error('drive rpc failed')
    return packet.result
  }
  const call: DriveCall = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args }) as { isError?: boolean; content?: { type: string; text: string }[] }
    const text = result.content?.find(part => part.type === 'text')?.text
    if (typeof text !== 'string') throw new Error('drive tool result missing')
    return { isError: result.isError === true, value: JSON.parse(text) as Record<string, unknown> }
  }
  try {
    const initialized = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'mikka-run-drive', version: '1' } })
    if (['2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized.protocolVersion)) version = initialized.protocolVersion
    await rpc('notifications/initialized', {}, true)
    const plan = await call('drive_sync_scopes', {})
    if (plan.isError) return undefined
    const scopes = z.array(scopeSchema).max(8).parse(plan.value.scopes)
    if (!scopes.length) return undefined
    return createDriveMirror({ root: host.root, runId: host.assignment.runId, scopes, call, warn: host.warn })
  } catch (error) {
    // An older server without the tool, or a refusal: the run goes on without a mirror.
    host.warn?.('drive mirror unavailable', { error: error instanceof Error ? error.name : 'Error' })
    return undefined
  }
}
