import { constants, type BigIntStats } from 'node:fs'
import { open, realpath, mkdtemp, mkdir, writeFile, rm, lstat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname, join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { execa } from 'execa'
import {
  CodingWorkspaceError, visibleWorkspacePath, workspaceReadCommand,
  type WorkspaceReadCommand, type WorkspaceReadReceipt,
} from '@mikka/protocol/coding-workspace'
import {
  WORKSPACE_DIFF_MAX_BLOB_BYTES, WORKSPACE_DIFF_MAX_FILES, diffFileVersionMaterial,
  type DiffFileMetadata, type DiffRevision, type WorkspaceDiffReadRequest,
} from '@mikka/protocol/coding-workspace-review'
import type { GitWorkingFence, WorkspaceGitRevertPreviewResult } from '@mikka/protocol/coding-workspace-git'
import { remoteKey } from '@mikka/protocol/repository'
import { worktreeGitDir } from '../agents/publish'
import { buildChildEnv } from '../env'
import type { JournalEntry } from '../runs/journal'
import { mountId, safeFile, type WorkspaceRoot } from './files'
import { cleanAction, GitTextStats, CRLFCleaner, type CleanAction, type CleanAttributes } from './eol'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
/** The fence mode is a closed set; an unknown mode is never guessed. */
const fenceMode = (mode: string | null | undefined): GitWorkingFence['mode'] =>
  mode === '100644' || mode === '100755' || mode === '120000' || mode === '160000' ? mode : null
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1536 * 1024
type ObjectFile = { path: string; blob: string | null; mode: string; size: number | null; binary?: boolean; workingVersion?: string;
  rawBlob?: string; rawSize?: number; unavailableReason?: DiffFileMetadata['unavailableReason'] }
type Git = ((args: string[], maximum?: number) => Promise<Buffer>) & { commonDir: string; config: (key: string, type: 'bool' | 'bool-or-str' | 'path', fallback: string) => Promise<string> }
type WorkingConversion = { index: Map<string, ObjectFile>; unmerged: Set<string>; actions: Map<string, CleanAction>; fileMode: boolean;
  fence: string; paths: string[]; rawIndex: string; attributeFences: Map<string, string>; indexCRLF: Map<string, boolean | null> }
type Snapshot = { revision: DiffRevision; files: DiffFileMetadata[]; conversion?: WorkingConversion }
const statFence = (stat: BigIntStats) => digest(`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.mode}`)
export { statFence }
function pathsText(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch (cause) { throw new CodingWorkspaceError('workspace_unsupported', { cause }) }
}

export function missing(error: unknown): boolean {
  for (let depth = 0; error && typeof error === 'object' && depth < 8; depth++) {
    if ('code' in error && error.code === 'ENOENT') return true
    error = 'cause' in error ? error.cause : null
  }
  return false
}

/** Git reads use the daemon's registered clone, never a .git file in source.
 * No status/add/diff against the filesystem: those can invoke clean filters.
 * Only object reads, index path names and ignore-aware untracked names run. */
export async function gitFor(repoPath: string, root: WorkspaceRoot, signal: AbortSignal): Promise<Git> {
  const gitDir = await worktreeGitDir(repoPath, root.path, signal)
  const env = { ...buildChildEnv({}), GIT_DIR: gitDir, GIT_COMMON_DIR: resolve(gitDir, '..', '..'),
    // cwd is resolved while the parent's FD is still open. The child does not
    // inherit that numeric descriptor, so its work tree must be relative to cwd.
    GIT_WORK_TREE: '.', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
  const run = async (args: string[], maximum = MAX_MANIFEST_BYTES, nativeConfig = false) => {
    try {
      const childEnv: Record<string, string> = { ...env }
      if (nativeConfig) { delete childEnv.GIT_CONFIG_NOSYSTEM; delete childEnv.GIT_CONFIG_GLOBAL }
      const result = await execa('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'protocol.ext.allow=never', ...args], { cwd: root.gitPath, env: childEnv, extendEnv: false,
        encoding: 'buffer', stripFinalNewline: false, stdin: 'ignore', maxBuffer: maximum,
        cancelSignal: signal, killDescendants: true, timeout: 5000 })
      return Buffer.from(result.stdout)
    } catch (cause) { throw new CodingWorkspaceError('workspace_checkout_unavailable', { cause }) }
  }
  return Object.assign(run, { commonDir: env.GIT_COMMON_DIR,
    config: async (key: string, type: 'bool' | 'bool-or-str' | 'path', fallback: string) =>
      (await run(['config', `--type=${type}`, '--default', fallback, '--get', key], 16 * 1024, true)).toString().trim() })
}

async function treeFiles(git: Git, commit: string): Promise<Map<string, ObjectFile>> {
  if (!oid.test(commit)) throw new CodingWorkspaceError('workspace_invalid_request')
  const output = pathsText(await git(['ls-tree', '-r', '-l', '-z', commit]))
  const all = output.split('\0').filter(Boolean)
  if (all.length > WORKSPACE_DIFF_MAX_FILES) throw new CodingWorkspaceError('workspace_limit_exceeded')
  const result = new Map<string, ObjectFile>()
  for (const item of all) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?) +([0-9]+|-)\t([\s\S]+)$/.exec(item)
    if (!match) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const [, mode, type, blob, size, path] = match
    if (!visibleWorkspacePath(path!)) continue
    if (!['blob', 'commit'].includes(type!)) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    result.set(path!, { path: path!, mode: mode!, blob: blob!, size: size === '-' ? null : Number(size) })
  }
  return result
}

async function existsWithoutReading(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error }
}

async function conversionSettings(git: Git) {
  const [autoCRLF, fileMode, external] = await Promise.all([
    git.config('core.autocrlf', 'bool-or-str', 'false'), git.config('core.filemode', 'bool', 'true'),
    git.config('core.attributesfile', 'path', ''),
  ])
  if (!['true', 'false', 'input'].includes(autoCRLF) || !['true', 'false'].includes(fileMode))
    throw new CodingWorkspaceError('workspace_unsupported')
  // An attributes read must not escape the Run. These external sources are
  // explicitly unsupported, rather than ignored and reported as a fake edit.
  if (external && external !== '/dev/null') throw new CodingWorkspaceError('workspace_unsupported')
  const host = buildChildEnv({})
  const defaults = ['/etc/gitattributes', '/usr/etc/gitattributes', '/usr/local/etc/gitattributes']
  if (!external) {
    const configHome = host.XDG_CONFIG_HOME || (host.HOME ? join(host.HOME, '.config') : undefined)
    if (configHome) defaults.push(join(configHome, 'git', 'attributes'))
  }
  const info = join(git.commonDir, 'info')
  if (await existsWithoutReading(info)) {
    if (!(await lstat(info)).isDirectory() || await existsWithoutReading(join(info, 'attributes')))
      throw new CodingWorkspaceError('workspace_unsupported')
  }
  for (const path of defaults) if (await existsWithoutReading(path)) throw new CodingWorkspaceError('workspace_unsupported')
  return { autoCRLF, fileMode: fileMode === 'true' }
}

async function workingConversion(git: Git, root: WorkspaceRoot, paths: string[], head: string, signal: AbortSignal,
  budget: { bytes: number }): Promise<WorkingConversion> {
  const settings = await conversionSettings(git)
  const rawIndex = pathsText(await git(['ls-files', '--stage', '-z']))
  const index = new Map<string, ObjectFile>(), unmerged = new Set<string>()
  for (const item of rawIndex.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t([\s\S]+)$/.exec(item)
    if (!match) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const [, mode, blob, stage, path] = match
    if (stage !== '0') unmerged.add(path!)
    if (stage === '0' || (stage === '2' && !index.has(path!))) index.set(path!, { path: path!, mode: mode!, blob: blob!, size: null })
  }
  const attributePaths = new Set<string>(['.gitattributes'])
  for (const path of paths) {
    let parent = posix.dirname(path)
    while (parent !== '.') { attributePaths.add(`${parent}/.gitattributes`); parent = posix.dirname(parent) }
  }
  const attributeFences = new Map<string, string>(), attributeBytes = new Map<string, Buffer>()
  let total = 0
  for (const path of [...attributePaths].sort()) {
    signal.throwIfAborted()
    const current = await currentFile(root, path, head, budget, signal)
    attributeFences.set(path, current?.fence ?? 'missing')
    let bytes = current?.bytes
    if (current && !bytes) throw new CodingWorkspaceError('workspace_unsupported')
    const staged = index.get(path)
    if (!current && staged?.blob) {
      if (!['100644', '100755'].includes(staged.mode)) throw new CodingWorkspaceError('workspace_unsupported')
      bytes = await git(['cat-file', 'blob', staged.blob], WORKSPACE_DIFF_MAX_BLOB_BYTES + 1)
      budget.bytes += bytes.length
    }
    if (!bytes) continue
    total += bytes.length
    if (total > 2 * WORKSPACE_DIFF_MAX_BLOB_BYTES || budget.bytes > MAX_SCAN_BYTES) throw new CodingWorkspaceError('workspace_limit_exceeded')
    // check-attr prints reserved literal strings exactly like boolean states.
    // Refuse those ambiguous declarations, including inside macro definitions.
    if (bytes.includes(0) || /(?:^|[\t ])(?:text|eol|crlf|filter|working-tree-encoding|ident)=(?:set|unset|unspecified)(?=[\t \r\n]|$)/m.test(bytes.toString('utf8')))
      throw new CodingWorkspaceError('workspace_unsupported')
    attributeBytes.set(path, bytes)
  }
  const directory = await mkdtemp(join(tmpdir(), 'mikka-diff-attributes-'))
  const actions = new Map<string, CleanAction>()
  try {
    const gitDir = join(directory, 'git'), worktree = join(directory, 'worktree')
    await mkdir(worktree, { mode: 0o700 })
    const env = { ...buildChildEnv({}), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
    await execa('git', ['init', '--bare', '--quiet', '--template=', gitDir], { env, extendEnv: false, stdin: 'ignore',
      cancelSignal: signal, timeout: 5000, maxBuffer: 4096, killDescendants: true })
    for (const [path, bytes] of attributeBytes) {
      const target = join(worktree, path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
    }
    const attributes = ['text', 'eol', 'crlf', 'filter', 'working-tree-encoding', 'ident'] as const
    const allowedPaths = new Set(paths)
    const output = await execa('git', ['--git-dir', gitDir, '--work-tree', worktree, '-c', 'core.bare=false',
      '-c', 'core.attributesFile=/dev/null', 'check-attr', '-z', '--stdin', ...attributes], {
      env, extendEnv: false, input: Buffer.from(paths.join('\0') + (paths.length ? '\0' : '')), encoding: 'buffer', stripFinalNewline: false,
      cancelSignal: signal, timeout: 5000, maxBuffer: 8 * 1024 * 1024, killDescendants: true })
    const parts = pathsText(Buffer.from(output.stdout)).split('\0')
    if (parts.pop() !== '' || parts.length !== paths.length * attributes.length * 3)
      throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const values = new Map<string, CleanAttributes>()
    for (let offset = 0; offset < parts.length; offset += 3) {
      const path = parts[offset]!, name = parts[offset + 1]!, value = parts[offset + 2]!
      if (!allowedPaths.has(path) || !attributes.includes(name as typeof attributes[number])) throw new CodingWorkspaceError('workspace_checkout_unavailable')
      const row = values.get(path) ?? {} as CleanAttributes
      row[name as typeof attributes[number]] = value; values.set(path, row)
    }
    for (const path of paths) actions.set(path, cleanAction(values.get(path)!, settings.autoCRLF))
  } finally { await rm(directory, { recursive: true, force: true }) }
  return { index, unmerged, actions, fileMode: settings.fileMode, rawIndex, attributeFences, paths, indexCRLF: new Map(),
    fence: digest(JSON.stringify([settings, rawIndex])) }
}

async function verifyConversion(git: Git, root: WorkspaceRoot, value: WorkingConversion) {
  const settings = await conversionSettings(git), index = pathsText(await git(['ls-files', '--stage', '-z']))
  if (digest(JSON.stringify([settings, index])) !== value.fence) throw new CodingWorkspaceError('workspace_version_conflict')
  for (const [path, expected] of value.attributeFences)
    if (await currentFence(root, path) !== expected) throw new CodingWorkspaceError('workspace_version_conflict')
}

async function currentFile(root: WorkspaceRoot, path: string, head: string, budget: { bytes: number }, signal: AbortSignal,
  conversion?: WorkingConversion, git?: Git): Promise<{ file: ObjectFile; bytes: Buffer | null; fence: string } | null> {
  try {
    return await safeFile(root, path, async handle => {
      const before = await handle.stat({ bigint: true }), size = Number(before.size)
      const staged = conversion?.index.get(path)
      const mode = conversion?.fileMode === false ? (staged?.mode ?? '100644') : before.mode & 0o100n ? '100755' : '100644'
      const action = conversion?.actions.get(path) ?? 'raw'
      const unavailable = (reason: DiffFileMetadata['unavailableReason']) => ({ file: { path, blob: null, mode: '000000', size: null,
        unavailableReason: reason, workingVersion: statFence(before) }, bytes: null, fence: statFence(before) })
      if (conversion?.unmerged.has(path)) return unavailable('unmerged_index')
      if (action === 'unsupported') return unavailable('custom_conversion')
      budget.bytes += size
      if (budget.bytes > MAX_SCAN_BYTES) throw new CodingWorkspaceError('workspace_limit_exceeded')
      // Hash large files without retaining their bytes. A source-view byte cap
      // must not make an unchanged tracked asset appear modified forever.
      const algorithm = head.length === 64 ? 'sha256' : 'sha1'
      const hasher = createHash(algorithm).update(`blob ${size}\0`), stats = new GitTextStats()
      const bytes = size <= WORKSPACE_DIFF_MAX_BLOB_BYTES ? Buffer.alloc(size) : null
      const chunk = Buffer.alloc(64 * 1024)
      let offset = 0
      while (offset < size) {
        signal.throwIfAborted()
        const read = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset)
        if (read.bytesRead === 0) throw new CodingWorkspaceError('workspace_version_conflict')
        const part = chunk.subarray(0, read.bytesRead)
        hasher.update(part); stats.push(part); bytes?.set(part, offset); offset += read.bytesRead
      }
      const rawBlob = hasher.digest('hex')
      let normalize = stats.crlf > 0 && (action === 'text' || (action === 'auto' && !stats.binary))
      if (normalize && action === 'auto' && staged?.blob) {
        if (staged.blob === rawBlob) normalize = false
        else {
          let indexCRLF = conversion!.indexCRLF.get(staged.blob)
          if (indexCRLF === undefined) {
            const length = Number((await git!(['cat-file', '-s', staged.blob], 128)).toString().trim())
            if (!Number.isSafeInteger(length) || length < 0) throw new CodingWorkspaceError('workspace_checkout_unavailable')
            if (length > WORKSPACE_DIFF_MAX_BLOB_BYTES) indexCRLF = null
            else {
              budget.bytes += length
              if (budget.bytes > MAX_SCAN_BYTES) throw new CodingWorkspaceError('workspace_limit_exceeded')
              const stored = new GitTextStats(); stored.push(await git!(['cat-file', 'blob', staged.blob], WORKSPACE_DIFF_MAX_BLOB_BYTES + 1))
              indexCRLF = !stored.binary && stored.crlf > 0
            }
            conversion!.indexCRLF.set(staged.blob, indexCRLF)
          }
          if (indexCRLF === null) return unavailable('conversion_limit')
          if (indexCRLF) normalize = false
        }
      }
      let blob = rawBlob, cleanSize = size
      if (normalize) {
        cleanSize -= stats.crlf
        const cleaned = createHash(algorithm).update(`blob ${cleanSize}\0`), cleaner = new CRLFCleaner()
        if (bytes) cleaned.update(cleaner.push(bytes))
        else {
          budget.bytes += size
          if (budget.bytes > MAX_SCAN_BYTES) throw new CodingWorkspaceError('workspace_limit_exceeded')
          offset = 0
          while (offset < size) {
            signal.throwIfAborted()
            const read = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset)
            if (!read.bytesRead) throw new CodingWorkspaceError('workspace_version_conflict')
            cleaned.update(cleaner.push(chunk.subarray(0, read.bytesRead))); offset += read.bytesRead
          }
        }
        cleaned.update(cleaner.finish()); blob = cleaned.digest('hex')
      }
      const after = await handle.stat({ bigint: true })
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.mode !== before.mode)
        throw new CodingWorkspaceError('workspace_version_conflict')
      let binary = bytes?.includes(0) ?? false
      if (bytes && !binary) { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { binary = true } }
      return { file: { path, mode, size: cleanSize, blob, binary, ...(normalize ? { rawBlob, rawSize: size } : {}) }, bytes, fence: statFence(after) }
    })
  } catch (error) {
    if (missing(error)) return null
    // Unsafe links/special files remain visible as unavailable metadata when
    // tracked, but their target and bytes are never opened or copied.
    if (error instanceof CodingWorkspaceError && error.code === 'workspace_path_unavailable')
      return { file: { path, blob: null, mode: '000000', size: null, unavailableReason: 'file_type' }, bytes: null, fence: 'unavailable' }
    throw error
  }
}

async function currentFence(root: WorkspaceRoot, path: string): Promise<string> {
  try { return await safeFile(root, path, async handle => statFence(await handle.stat({ bigint: true }))) }
  catch (error) {
    if (missing(error)) return 'missing'
    if (error instanceof CodingWorkspaceError && error.code === 'workspace_path_unavailable') return 'unavailable'
    throw error
  }
}

function metadata(repoId: string, revision: DiffRevision, old: ObjectFile | undefined, next: ObjectFile | undefined): DiffFileMetadata {
  const path = next?.path ?? old!.path, previousPath = old && next && old.path !== next.path ? old.path : null
  const file = { path, previousPath, status: next?.mode === '000000' ? 'unavailable' as const : !old ? 'added' as const : !next ? 'deleted' as const : previousPath ? 'renamed' as const : 'modified' as const,
    oldBlob: old?.blob ?? null, newBlob: next?.blob ?? null, oldMode: old?.mode ?? null, newMode: next?.mode ?? null,
    oldSize: old?.size ?? null, newSize: next?.size ?? null, ...(next?.workingVersion ? { workingVersion: next.workingVersion } : {}),
    ...(next?.rawBlob ? { rawBlob: next.rawBlob, rawSize: next.rawSize } : {}),
    ...(next?.unavailableReason ? { unavailableReason: next.unavailableReason } : {}) }
  return { ...file, binary: next?.binary ?? false, additions: 0, deletions: 0,
    fileVersion: digest(diffFileVersionMaterial(repoId, revision, file)) }
}

async function snapshot(git: Git, root: WorkspaceRoot, entry: JournalEntry, request: Extract<WorkspaceDiffReadRequest, { kind: 'diff_snapshot' }>, signal: AbortSignal): Promise<Snapshot> {
  const currentHead = (await git(['rev-parse', '--verify', 'HEAD'])).toString().trim()
  if (!oid.test(currentHead)) throw new CodingWorkspaceError('workspace_checkout_unavailable')
  const headSha = request.source === 'commit' ? request.headSha! : currentHead
  const baseSha = request.source === 'commit' ? request.baseSha! : entry.baseCommit ?? currentHead
  if (request.source === 'commit') {
    await git(['merge-base', '--is-ancestor', headSha, currentHead])
    await git(['merge-base', '--is-ancestor', baseSha, headSha])
  }
  const old = await treeFiles(git, baseSha), head = await treeFiles(git, headSha)
  const revision: DiffRevision = { source: request.source, baseSha, headSha, treeSha: request.source === 'commit'
    ? (await git(['rev-parse', `${headSha}^{tree}`])).toString().trim() : null, version: '0'.repeat(64) }
  let next = head
  const fences = new Map<string, string>()
  let inventory: string | undefined
  let conversion: WorkingConversion | undefined
  if (request.source === 'working') {
    inventory = pathsText(await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    const listed = inventory.split('\0').filter(Boolean)
    const paths = [...new Set([...old.keys(), ...head.keys(), ...listed.filter(visibleWorkspacePath)])].sort()
    if (paths.length > WORKSPACE_DIFF_MAX_FILES) throw new CodingWorkspaceError('workspace_limit_exceeded')
    next = new Map()
    const budget = { bytes: 0 }
    conversion = await workingConversion(git, root, paths, headSha, signal, budget)
    for (const path of paths) {
      signal.throwIfAborted()
      const value = await currentFile(root, path, headSha, budget, signal, conversion, git)
      if (value) next.set(path, value.file)
      fences.set(path, value?.fence ?? 'missing')
    }
  }
  const deleted = [...old.values()].filter(file => !next.has(file.path))
  const added = [...next.values()].filter(file => !old.has(file.path))
  // Exact-content renames are unambiguous. Edited moves remain an add/delete
  // pair rather than guessing a line mapping and attaching comments wrongly.
  const renames = new Map<string, ObjectFile>(), claimed = new Set<string>()
  for (const file of added) {
    if (!file.blob) continue
    const candidates = deleted.filter(item => item.blob === file.blob && item.mode === file.mode && !claimed.has(item.path))
    if (candidates.length === 1) { renames.set(file.path, candidates[0]!); claimed.add(candidates[0]!.path) }
  }
  const files: DiffFileMetadata[] = []
  for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    if (claimed.has(path)) continue
    const previous = renames.get(path) ?? old.get(path), current = next.get(path)
    if (previous && current && previous.path === current.path && previous.blob !== null && previous.blob === current.blob && previous.mode === current.mode) continue
    files.push(metadata(entry.assignment.repoId, revision, previous, current))
  }
  revision.version = digest(JSON.stringify([revision.source, baseSha, headSha, revision.treeSha, files.map(file => file.fileVersion)]))
  if (Buffer.byteLength(JSON.stringify(files)) > MAX_MANIFEST_BYTES) throw new CodingWorkspaceError('workspace_limit_exceeded')
  for (const [path, expected] of fences) {
    signal.throwIfAborted()
    if (await currentFence(root, path) !== expected) throw new CodingWorkspaceError('workspace_version_conflict')
  }
  if (inventory !== undefined && pathsText(await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])) !== inventory)
    throw new CodingWorkspaceError('workspace_version_conflict')
  if (conversion) await verifyConversion(git, root, conversion)
  if ((await git(['rev-parse', '--verify', 'HEAD'])).toString().trim() !== currentHead || await realpath(root.gitPath) !== root.path)
    throw new CodingWorkspaceError('workspace_version_conflict')
  return { revision, files, ...(conversion ? { conversion } : {}) }
}

/** A snapshot observes bounded, descriptor-checked source bytes. It never
 * stages files, writes Git objects/indexes, invokes filters or changes refs. */
export async function readWorkspaceDiffReceipt(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {  let directory: FileHandle | undefined
  try {
    const parsed = workspaceReadCommand.safeParse(command)
    if (!parsed.success) throw new CodingWorkspaceError('workspace_invalid_request', { cause: parsed.error })
    const { identity, request, expiresAt } = parsed.data
    if (request.kind !== 'diff_snapshot' && request.kind !== 'diff_file') throw new CodingWorkspaceError('workspace_invalid_request')
    const remaining = Date.parse(expiresAt) - Date.now()
    if (remaining <= 0) throw new CodingWorkspaceError('workspace_request_expired')
    if (!entry?.worktree || entry.assignment.runId !== identity.runId || entry.assignment.repoId !== identity.repoId || entry.assignment.deviceId !== identity.deviceId
      || remoteKey(entry.assignment.remoteUrl ?? entry.assignment.expectedRepoRemote ?? '') !== identity.repositoryKey)
      throw new CodingWorkspaceError('workspace_checkout_unavailable')
    if (process.platform !== 'linux') throw new CodingWorkspaceError('workspace_unsupported')
    const path = resolve(entry.worktree)
    if (await realpath(path) !== path) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const root: WorkspaceRoot = { path, handle: directory, device: (await directory.stat({ bigint: true })).dev,
      mountId: await mountId(directory), gitPath: `/proc/self/fd/${directory.fd}` }
    const signal = AbortSignal.timeout(remaining), git = await gitFor(repoPath, root, signal)
    if (remoteKey((await git(['config', '--get', 'remote.origin.url'])).toString().trim()) !== identity.repositoryKey)
      throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const selection = request.kind === 'diff_snapshot' ? request : request.revision.source === 'working'
      ? { kind: 'diff_snapshot' as const, source: 'working' as const }
      : { kind: 'diff_snapshot' as const, source: 'commit' as const, headSha: request.revision.headSha!, baseSha: request.revision.baseSha! }
    const value = await snapshot(git, root, entry, selection, signal)
    if (Date.parse(expiresAt) <= Date.now()) throw new CodingWorkspaceError('workspace_request_expired')
    const observation = { ok: true as const, identity, revision: value.revision, availability: 'online' as const, observedAt: new Date().toISOString() }
    signal.throwIfAborted()
    if (request.kind === 'diff_snapshot') return { result: { ...observation, kind: 'diff_snapshot', files: value.files }, files: [] }
    const file = value.files.find(file => file.path === request.file.path && file.fileVersion === request.file.fileVersion)
    if (!file || value.revision.version !== request.revision.version) throw new CodingWorkspaceError('workspace_version_conflict')
    const result = { ...observation, kind: 'diff_file' as const, snapshotId: request.snapshotId, sourceVersion: value.revision.version,
      file, format: 'unavailable' as 'unavailable' | 'too_large' | 'text', patch: null, hunks: [] }
    if ([file.oldMode, file.newMode].some(mode => mode !== null && !['100644', '100755'].includes(mode))) return { result, files: [] }
    if ([file.oldSize, file.newSize, file.rawSize].some(size => size !== null && size !== undefined && size > WORKSPACE_DIFF_MAX_BLOB_BYTES))
      return { result: { ...result, format: 'too_large' }, files: [] }
    const blobs = new Map<string, { bytes: Buffer; rawSha?: string }>()
    if (file.oldBlob) blobs.set(file.oldBlob, { bytes: await git(['cat-file', 'blob', file.oldBlob], WORKSPACE_DIFF_MAX_BLOB_BYTES + 1) })
    if (file.newBlob) {
      if (value.revision.source === 'working') {
        const current = await currentFile(root, file.path, value.revision.headSha!, { bytes: 0 }, signal, value.conversion, git)
        if (!current?.bytes || current.file.blob !== file.newBlob || current.file.rawBlob !== file.rawBlob)
          throw new CodingWorkspaceError('workspace_version_conflict')
        blobs.set(file.newBlob, { bytes: current.bytes, ...(file.rawBlob ? { rawSha: file.rawBlob } : {}) })
      } else blobs.set(file.newBlob, { bytes: await git(['cat-file', 'blob', file.newBlob], WORKSPACE_DIFF_MAX_BLOB_BYTES + 1) })
    }
    if (value.conversion) await verifyConversion(git, root, value.conversion)
    if (Date.parse(expiresAt) <= Date.now()) throw new CodingWorkspaceError('workspace_request_expired')
    if ((value.revision.source === 'working' && (await git(['rev-parse', '--verify', 'HEAD'])).toString().trim() !== value.revision.headSha)
      || await realpath(root.gitPath) !== root.path) throw new CodingWorkspaceError('workspace_version_conflict')
    return { result: { ...result, format: 'text' }, files: [], blobs: [...blobs].map(([sha, proof]) => ({ sha, base64: proof.bytes.toString('base64'),
      ...(proof.rawSha ? { clean: 'crlf_to_lf' as const, rawSha: proof.rawSha } : {}) })) }
  } catch (cause) {
    return { result: { ok: false, code: Date.parse(command.expiresAt) <= Date.now() ? 'workspace_request_expired'
      : cause instanceof CodingWorkspaceError ? cause.code : 'workspace_checkout_unavailable' }, files: [] }
  } finally { await directory?.close() }
}

/** Revert preview is a read: it proves the current and base bytes of exactly
 * one file in the same snapshot the client reviewed. It never writes. */
export async function readWorkspaceRevertPreview(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  try {
    const parsed = workspaceReadCommand.safeParse(command)
    if (!parsed.success) throw new CodingWorkspaceError('workspace_invalid_request', { cause: parsed.error })
    const { identity, request, expiresAt } = parsed.data
    if (request.kind !== 'git_revert_preview') throw new CodingWorkspaceError('workspace_invalid_request')
    const remaining = Date.parse(expiresAt) - Date.now()
    if (remaining <= 0) throw new CodingWorkspaceError('workspace_request_expired')
    if (!entry?.worktree || entry.assignment.runId !== identity.runId || entry.assignment.repoId !== identity.repoId || entry.assignment.deviceId !== identity.deviceId
      || remoteKey(entry.assignment.remoteUrl ?? entry.assignment.expectedRepoRemote ?? '') !== identity.repositoryKey)
      throw new CodingWorkspaceError('workspace_checkout_unavailable')
    if (process.platform !== 'linux') throw new CodingWorkspaceError('workspace_unsupported')
    const path = resolve(entry.worktree)
    if (await realpath(path) !== path) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const root: WorkspaceRoot = { path, handle: directory, device: (await directory.stat({ bigint: true })).dev,
      mountId: await mountId(directory), gitPath: `/proc/self/fd/${directory.fd}` }
    const signal = AbortSignal.timeout(remaining), git = await gitFor(repoPath, root, signal)
    if (remoteKey((await git(['config', '--get', 'remote.origin.url'])).toString().trim()) !== identity.repositoryKey)
      throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const value = await snapshot(git, root, entry, { kind: 'diff_snapshot', source: 'working' }, signal)
    if (value.revision.version !== request.revision.version) throw new CodingWorkspaceError('workspace_version_conflict')
    const file = value.files.find(candidate => candidate.path === request.file.path)
    if (!file || file.fileVersion !== request.file.fileVersion || file.path !== request.file.path
      || file.previousPath !== request.file.previousPath || file.status !== request.file.status
      || file.oldBlob !== request.file.oldBlob || file.newBlob !== request.file.newBlob
      || file.oldMode !== request.file.oldMode || file.newMode !== request.file.newMode) throw new CodingWorkspaceError('workspace_version_conflict')
    if (file.previousPath !== null || !['added', 'deleted', 'modified'].includes(file.status)
      || [file.oldMode, file.newMode].some(mode => mode !== null && !['100644', '100755'].includes(mode))
      || [file.oldSize, file.newSize, file.rawSize].some(size => size !== null && size !== undefined && size > WORKSPACE_DIFF_MAX_BLOB_BYTES))
      throw new CodingWorkspaceError('workspace_unsupported')
    if (request.target.kind === 'hunks' && (file.binary || file.rawBlob !== undefined))
      throw new CodingWorkspaceError('workspace_unsupported')
    const oldBytes = file.oldBlob ? await git(['cat-file', 'blob', file.oldBlob], WORKSPACE_DIFF_MAX_BLOB_BYTES + 1) : null
    if (file.oldBlob && (!oldBytes || (file.oldSize !== null && file.oldSize !== undefined && oldBytes.length !== file.oldSize)))
      throw new CodingWorkspaceError('workspace_version_conflict')
    const current = file.newBlob ? await currentFile(root, file.path, value.revision.headSha!, { bytes: 0 }, signal, value.conversion, git) : null
    if (file.newBlob && (!current?.bytes || current.file.blob !== file.newBlob || current.file.rawBlob !== file.rawBlob))
      throw new CodingWorkspaceError('workspace_version_conflict')
    if (file.newBlob === null && current !== null) throw new CodingWorkspaceError('workspace_version_conflict')
    // The observation fences exactly what the person is about to change;
    // the apply request must present these values or be refused.
    const observedMode = fenceMode(current?.file.mode)
    const before = {
      headSha: value.revision.headSha!, path: file.path, exists: current !== null,
      mode: observedMode,
      size: current?.bytes?.length ?? null,
      contentSha256: current?.bytes ? digest(current.bytes) : null,
      workingVersion: current?.fence ?? digest('missing'),
    }
    if (value.conversion) await verifyConversion(git, root, value.conversion)
    if (Date.parse(expiresAt) <= Date.now()) throw new CodingWorkspaceError('workspace_request_expired')
    if ((await git(['rev-parse', '--verify', 'HEAD'])).toString().trim() !== value.revision.headSha
      || await realpath(root.gitPath) !== root.path) throw new CodingWorkspaceError('workspace_version_conflict')
    const blobs: NonNullable<WorkspaceReadReceipt['blobs']> = []
    if (file.oldBlob && oldBytes) blobs.push({ sha: file.oldBlob, base64: oldBytes.toString('base64') })
    if (file.newBlob && current?.bytes) blobs.push({ sha: file.newBlob, base64: current.bytes.toString('base64'),
      ...(file.rawBlob ? { clean: 'crlf_to_lf' as const, rawSha: file.rawBlob } : {}) })
    const result: WorkspaceGitRevertPreviewResult = { ok: true, identity, kind: 'git_revert_preview', operationId: request.operationId,
      observedAt: new Date().toISOString(), availability: 'online', revision: value.revision, file, target: request.target, before }
    return { result, files: [], ...(blobs.length ? { blobs } : {}) }
  } catch (cause) {
    return { result: { ok: false, code: Date.parse(command.expiresAt) <= Date.now() ? 'workspace_request_expired'
      : cause instanceof CodingWorkspaceError ? cause.code : 'workspace_checkout_unavailable' }, files: [] }
  } finally { await directory?.close() }
}
