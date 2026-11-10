import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readFile, realpath, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execa } from 'execa'
import {
  CodingWorkspaceError, visibleWorkspacePath, workspaceReadCommand,
  type WorkspaceReadCommand, type WorkspaceReadReceipt,
} from '@mikka/protocol/coding-workspace'
import {
  WORKSPACE_GIT_MAX_COMMITS, WORKSPACE_GIT_MAX_STATUS_ENTRIES, WORKSPACE_GIT_MAX_UNDO_BYTES, WORKSPACE_GIT_MAX_UNDO_FILES,
  gitCheckpointPreviewVersion, gitRevertPreviewVersion, workspaceGitCheckpointPreviewResult, workspaceGitCheckpointRestoreResult,
  workspaceGitRevertApplyResult, workspaceGitUndoResult, gitStatus as gitStatusSchema, gitHistory as gitHistorySchema,
  type GitBranchState, type GitHistory, type GitStatus, type GitStatusEntry, type GitWorkingFence,
  type WorkspaceGitCheckpointPreviewRequest, type WorkspaceGitCheckpointPreviewResult, type WorkspaceGitCheckpointRestoreRequest,
  type WorkspaceGitCheckpointRestoreResult, type WorkspaceGitRevertApplyRequest, type WorkspaceGitRevertApplyResult,
  type WorkspaceGitUndoResult, type GitUndoFile,
} from '@mikka/protocol/coding-workspace-git'
import { remoteKey } from '@mikka/protocol/repository'
import { buildChildEnv } from '../env'
import type { JournalEntry } from '../runs/journal'
import { gitFor, missing, readWorkspaceRevertPreview, statFence } from './diff'
import { mountId, safeFile, type WorkspaceRoot } from './files'
import { gitLogFormat, historyCursor, parseGitLog, parseHistoryCursor, parsePorcelainV2 } from './git-parse'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const STATUS_BYTES = 8 * 1024 * 1024
const STATUS_SCAN_BYTES = 16 * 1024 * 1024
const RESTORE_SCAN_BYTES = 8 * 1024 * 1024
const RESTORE_FILE_BYTES = 1024 * 1024
type Git = Awaited<ReturnType<typeof gitFor>>
type Mode = '100644' | '100755'
type ObservedFile = { exists: boolean; bytes: Buffer | null; mode: Mode | null; size: number | null
  contentSha256: string | null; workingVersion: string; fence?: string; unsafe?: boolean }

const conflict = () => new CodingWorkspaceError('workspace_version_conflict')
const unavailable = () => new CodingWorkspaceError('workspace_checkout_unavailable')

function failure(command: WorkspaceReadCommand, cause: unknown): WorkspaceReadReceipt {
  return { result: { ok: false, code: Date.parse(command.expiresAt) <= Date.now() ? 'workspace_request_expired'
    : cause instanceof CodingWorkspaceError ? cause.code : 'workspace_checkout_unavailable' }, files: [] }
}

/** Same journal, token, checkout and remote contract as Files/Diff. */
async function openPinnedRoot(command: WorkspaceReadCommand, entry: JournalEntry | undefined) {
  const parsed = workspaceReadCommand.safeParse(command)
  if (!parsed.success) throw new CodingWorkspaceError('workspace_invalid_request', { cause: parsed.error })
  const { identity, expiresAt } = parsed.data
  const remaining = Date.parse(expiresAt) - Date.now()
  if (remaining <= 0) throw new CodingWorkspaceError('workspace_request_expired')
  if (!entry?.worktree || entry.assignment.runId !== identity.runId || entry.assignment.repoId !== identity.repoId
    || entry.assignment.deviceId !== identity.deviceId
    || remoteKey(entry.assignment.remoteUrl ?? entry.assignment.expectedRepoRemote ?? '') !== identity.repositoryKey)
    throw unavailable()
  if (process.platform !== 'linux') throw new CodingWorkspaceError('workspace_unsupported')
  const path = resolve(entry.worktree)
  if (await realpath(path) !== path) throw unavailable()
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const root: WorkspaceRoot = { path, handle: directory, device: (await directory.stat({ bigint: true })).dev,
      mountId: await mountId(directory), gitPath: `/proc/self/fd/${directory.fd}` }
    return { parsed: parsed.data, root, directory, remaining }
  } catch (error) { await directory.close(); throw error }
}
const closeRoot = (directory: FileHandle | undefined) => directory ? directory.close() : Promise.resolve()

async function headSha(git: Git) {
  const value = (await git(['rev-parse', '--verify', 'HEAD'])).toString().trim()
  if (!oid.test(value)) throw unavailable()
  return value
}

/** Bounded, descriptor-checked observation of one worktree path. Missing and
 * unsafe paths stay distinguishable; neither ever follows a symlink. */
async function observePath(root: WorkspaceRoot, path: string, maximum = RESTORE_FILE_BYTES): Promise<ObservedFile> {
  try {
    return await safeFile(root, path, async file => {
      const before = await file.stat({ bigint: true }), size = Number(before.size)
      const fence = statFence(before), mode: Mode = before.mode & 0o111n ? '100755' : '100644'
      if (size > maximum) return { exists: true, bytes: null, mode, size, contentSha256: null, workingVersion: fence, fence }
      const bytes = Buffer.alloc(size + 1)
      const { bytesRead } = await file.read(bytes, 0, size + 1, 0)
      const after = await file.stat({ bigint: true })
      if (bytesRead !== size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size)
        throw conflict()
      const contents = bytes.subarray(0, size)
      return { exists: true, bytes: contents, mode, size, contentSha256: digest(contents), workingVersion: fence, fence }
    })
  } catch (error) {
    if (missing(error)) return { exists: false, bytes: null, mode: null, size: null, contentSha256: null, workingVersion: digest('missing') }
    if (error instanceof CodingWorkspaceError && error.code === 'workspace_path_unavailable')
      return { exists: false, bytes: null, mode: null, size: null, contentSha256: null, workingVersion: digest('unavailable'), unsafe: true }
    throw error
  }
}

async function openParent(root: WorkspaceRoot, path: string) {
  if (!visibleWorkspacePath(path) || !path) throw new CodingWorkspaceError('workspace_path_unavailable')
  const parts = path.split('/'), parents: FileHandle[] = []
  let parent = root.handle
  try {
    for (let index = 0; index < parts.length - 1; index++) {
      const handle = await open(`/proc/self/fd/${parent.fd}/${parts[index]}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      parents.push(handle)
      const stat = await handle.stat({ bigint: true })
      if (stat.dev !== root.device || await mountId(handle) !== root.mountId) throw new CodingWorkspaceError('workspace_path_unavailable')
      parent = handle
    }
    return { parent, name: parts.at(-1)!, parents }
  } catch (error) {
    await Promise.all(parents.map(handle => handle.close()))
    if (error instanceof CodingWorkspaceError) throw error
    throw new CodingWorkspaceError('workspace_path_unavailable', { cause: error })
  }
}

/** Whether every directory between the pinned root and `path` can be opened
 * without following a symlink or crossing a mount. A create into a missing
 * directory is refused during the dry run, before any real file is touched. */
async function parentDirectoryExists(root: WorkspaceRoot, path: string) {
  let opened: Awaited<ReturnType<typeof openParent>> | undefined
  try { opened = await openParent(root, path); return true }
  catch { return false }
  finally { if (opened) await Promise.all(opened.parents.map(handle => handle.close())) }
}

/** Write through the pinned parent descriptor, never through a re-resolved
 * absolute path. Existing targets must match their fence; new targets are
 * created O_EXCL so a concurrent creator is never overwritten. */
async function writePinnedFile(root: WorkspaceRoot, path: string, bytes: Buffer, executable: boolean,
  expectation: { fence?: string; createOnly?: boolean }) {
  const { parent, name, parents } = await openParent(root, path)
  let target: FileHandle | undefined
  try {
    const targetPath = `/proc/self/fd/${parent.fd}/${name}`
    const flags = constants.O_WRONLY | constants.O_NOFOLLOW
      | (expectation.createOnly ? constants.O_CREAT | constants.O_EXCL : 0)
    target = await open(targetPath, flags, executable ? 0o755 : 0o644)
    const before = await target.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n) throw new CodingWorkspaceError('workspace_path_unavailable')
    if (expectation.fence && statFence(before) !== expectation.fence) throw conflict()
    if (!expectation.createOnly && !expectation.fence) throw conflict()
    await target.truncate(0)
    await target.write(bytes, 0, bytes.length, 0)
    await target.sync()
    if (Number((await target.stat({ bigint: true })).size) !== bytes.length) throw conflict()
  } catch (error) {
    if (error instanceof CodingWorkspaceError) throw error
    if (missing(error)) throw conflict()
    throw new CodingWorkspaceError('workspace_path_unavailable', { cause: error })
  } finally {
    await target?.close()
    await Promise.all(parents.map(handle => handle.close()))
  }
}

async function deletePinnedFile(root: WorkspaceRoot, path: string, expectedFence?: string) {
  const { parent, name, parents } = await openParent(root, path)
  try {
    const targetPath = `/proc/self/fd/${parent.fd}/${name}`
    const stat = await lstat(targetPath, { bigint: true }).catch((error: unknown) => {
      if (!missing(error)) throw error
      return null
    })
    // A plan that expects absence must not delete a file that appeared.
    if (!stat) { if (expectedFence !== undefined) throw conflict(); return }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) throw new CodingWorkspaceError('workspace_path_unavailable')
    if (expectedFence === undefined || statFence(stat) !== expectedFence) throw conflict()
    await unlink(targetPath)
  } catch (error) {
    if (error instanceof CodingWorkspaceError) throw error
    if (missing(error)) throw conflict()
    throw new CodingWorkspaceError('workspace_path_unavailable', { cause: error })
  } finally { await Promise.all(parents.map(handle => handle.close())) }
}

function branchState(head: string, baseSha: string | null, parsed: ReturnType<typeof parsePorcelainV2>, upstreamKnown: boolean): GitBranchState {
  return { headSha: head, baseSha, branch: parsed.branch.branch, detached: parsed.branch.detached,
    upstream: parsed.branch.upstream && upstreamKnown ? parsed.branch.upstream : null }
}

function classifyBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false } catch { return true }
}
const isLfsPointer = (bytes: Buffer) => bytes.subarray(0, 200).toString('utf8').startsWith('version https://git-lfs.github.com/spec/')

/** One porcelain observation powers status and the history page's branch. */
async function observeStatus(git: Git, root: WorkspaceRoot, identity: WorkspaceReadCommand['identity'], baseSha: string | null,
  signal: AbortSignal): Promise<GitStatus> {
  const head = await headSha(git)
  const raw = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], STATUS_BYTES)
  const parsed = parsePorcelainV2(raw.toString('utf8'))
  if (parsed.branch.headSha !== head) throw conflict()
  let upstreamKnown = false
  if (parsed.branch.upstream) {
    try {
      const url = (await git(['config', '--get', `remote.${parsed.branch.upstream.remote}.url`], 16 * 1024)).toString().trim()
      upstreamKnown = Boolean(url) && remoteKey(url) === identity.repositoryKey
    } catch { upstreamKnown = false }
  }
  const observed: GitStatusEntry[] = []
  let scanned = 0, truncated = false
  for (const item of parsed.entries) {
    signal.throwIfAborted()
    if (observed.length >= WORKSPACE_GIT_MAX_STATUS_ENTRIES) { truncated = true; break }
    if (!visibleWorkspacePath(item.path) || (item.previousPath !== null && !visibleWorkspacePath(item.previousPath))) continue
    const file = await observePath(root, item.path, RESTORE_FILE_BYTES)
    scanned += file.size ?? 0
    observed.push({ path: item.path, previousPath: item.previousPath, index: item.index, worktree: item.worktree,
      conflicted: item.conflicted, untracked: item.untracked, mode: file.mode, size: file.size,
      contentSha256: file.contentSha256, workingVersion: file.workingVersion,
      binary: file.bytes && scanned <= STATUS_SCAN_BYTES ? classifyBinary(file.bytes) : null,
      lfs: Boolean(file.bytes && isLfsPointer(file.bytes)) })
  }
  const branch = branchState(head, baseSha, parsed, upstreamKnown)
  const version = digest(JSON.stringify([head, branch, observed.map(entry => [entry.path, entry.previousPath, entry.index,
    entry.worktree, entry.workingVersion, entry.contentSha256, entry.mode])]))
  return gitStatusSchema.parse({ ok: true, identity, kind: 'git_status', observedAt: new Date().toISOString(), availability: 'online',
    revision: { source: 'working', headSha: head, baseSha, version }, commitSha: head, workingTreeVersion: version,
    branch, entries: observed, truncated })
}

async function guardedGit(repoPath: string, opened: Awaited<ReturnType<typeof openPinnedRoot>>, signal: AbortSignal) {
  const git = await gitFor(repoPath, opened.root, signal)
  if (remoteKey((await git(['config', '--get', 'remote.origin.url'])).toString().trim()) !== opened.parsed.identity.repositoryKey)
    throw unavailable()
  return git
}

async function readGitStatus(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  try {
    const opened = await openPinnedRoot(command, entry); directory = opened.directory
    if (opened.parsed.request.kind !== 'git_status') throw new CodingWorkspaceError('workspace_invalid_request')
    const signal = AbortSignal.timeout(opened.remaining), git = await guardedGit(repoPath, opened, signal)
    const status = await observeStatus(git, opened.root, opened.parsed.identity, entry?.baseCommit ?? null, signal)
    if ((await headSha(git)) !== status.commitSha || await realpath(opened.root.gitPath) !== opened.root.path) throw conflict()
    return { result: status, files: [] }
  } catch (cause) { return failure(command, cause) } finally { await closeRoot(directory) }
}

async function readGitHistory(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  try {
    const opened = await openPinnedRoot(command, entry); directory = opened.directory
    const request = opened.parsed.request
    if (request.kind !== 'git_history') throw new CodingWorkspaceError('workspace_invalid_request')
    const signal = AbortSignal.timeout(opened.remaining), git = await guardedGit(repoPath, opened, signal)
    const status = await observeStatus(git, opened.root, opened.parsed.identity, entry?.baseCommit ?? null, signal)
    const offset = parseHistoryCursor(request.cursor, status.commitSha)
    if (offset === null) throw conflict()
    const raw = await git(['log', `--format=${gitLogFormat}`, '-n', String(Math.min(request.limit, WORKSPACE_GIT_MAX_COMMITS) + 1),
      `--skip=${offset}`, '--no-decorate'], STATUS_BYTES)
    const commits = parseGitLog(raw.toString('utf8'), { headSha: status.commitSha, baseSha: entry?.baseCommit ?? null })
    const history: GitHistory = gitHistorySchema.parse({ ok: true, identity: opened.parsed.identity, kind: 'git_history',
      observedAt: new Date().toISOString(), availability: 'online', revision: status.revision, commitSha: status.commitSha,
      workingTreeVersion: status.workingTreeVersion, branch: status.branch, commits: commits.slice(0, request.limit),
      nextCursor: commits.length > request.limit ? historyCursor(status.commitSha, offset + request.limit) : null })
    if ((await headSha(git)) !== status.commitSha || await realpath(opened.root.gitPath) !== opened.root.path) throw conflict()
    return { result: history, files: [] }
  } catch (cause) { return failure(command, cause) } finally { await closeRoot(directory) }
}

function fenceOf(path: string, headSha: string, observed: ObservedFile): GitWorkingFence {
  return { headSha, path, exists: observed.exists, mode: observed.mode, size: observed.size,
    contentSha256: observed.contentSha256, workingVersion: observed.workingVersion }
}

/** The same preview formula is recomputed by the server; a mismatch means the
 * client confirmed a different change than this worktree now shows. */
function revertPreviewVersion(request: WorkspaceGitRevertApplyRequest) {
  return gitRevertPreviewVersion({ operationId: request.operationId, revision: request.revision, file: request.file,
    target: request.target, before: request.expected, after: request.after })
}

async function readWorkspaceRevertApply(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  try {
    const opened = await openPinnedRoot(command, entry); directory = opened.directory
    const request = opened.parsed.request
    if (request.kind !== 'git_revert_apply') throw new CodingWorkspaceError('workspace_invalid_request')
    const signal = AbortSignal.timeout(opened.remaining), git = await guardedGit(repoPath, opened, signal)
    const head = await headSha(git)
    if (head !== request.expected.headSha) throw conflict()
    const observed = await observePath(opened.root, request.file.path)
    if (observed.unsafe) throw new CodingWorkspaceError('workspace_path_unavailable')
    // The commitment is checked before any state comparison so a request whose
    // body disagrees with the confirmed preview can never claim success.
    if (revertPreviewVersion(request) !== request.previewVersion) throw conflict()
    // A lost receipt can be retried: reaching the exact confirmed result is
    // success, not a second write and not a data-loss overwrite.
    if (observed.exists === request.after.exists && observed.contentSha256 === request.after.contentSha256
      && (!observed.exists || observed.mode === request.after.mode)) {
      const result = workspaceGitRevertApplyResult.parse({ ok: true, identity: opened.parsed.identity, kind: 'git_revert_applied',
        operationId: request.operationId, previewVersion: request.previewVersion, appliedAt: new Date().toISOString(), headSha: head,
        after: fenceOf(request.file.path, head, observed), idempotent: true })
      return { result, files: [] }
    }
    if (observed.workingVersion !== request.expected.workingVersion || observed.contentSha256 !== request.expected.contentSha256
      || observed.exists !== request.expected.exists || observed.mode !== request.expected.mode) throw conflict()
    // An empty confirmed file is still content: presence is what decides
    // between writing and deleting, never the truthiness of the string.
    const hasContent = request.contentBase64 !== undefined
    const bytes = hasContent ? Buffer.from(request.contentBase64!, 'base64') : null
    if (bytes && (bytes.toString('base64') !== request.contentBase64 || digest(bytes) !== request.after.contentSha256)) throw conflict()
    // The confirmed result must be fully specified: never delete a path whose
    // confirmed state is "exists", and never write one confirmed as absent.
    if (hasContent !== request.after.exists) throw conflict()
    if (bytes) await writePinnedFile(opened.root, request.file.path, bytes, request.after.mode === '100755',
      observed.exists ? { fence: observed.fence } : { createOnly: true })
    else await deletePinnedFile(opened.root, request.file.path, observed.fence)
    const after = await observePath(opened.root, request.file.path)
    if (after.exists !== request.after.exists || after.contentSha256 !== request.after.contentSha256
      || (after.exists && after.mode !== request.after.mode)) throw conflict()
    if ((await headSha(git)) !== head) throw conflict()
    const result = workspaceGitRevertApplyResult.parse({ ok: true, identity: opened.parsed.identity, kind: 'git_revert_applied',
      operationId: request.operationId, previewVersion: request.previewVersion, appliedAt: new Date().toISOString(), headSha: head,
      after: fenceOf(request.file.path, head, after), idempotent: false })
    const undo: GitUndoFile = { path: request.file.path, existed: observed.exists, mode: observed.mode,
      base64: observed.bytes?.toString('base64') ?? '', sha256: observed.contentSha256 ?? digest(''),
      after: { exists: after.exists, contentSha256: after.contentSha256 } }
    return { result, files: [], ...(observed.exists && !observed.bytes ? {} : { gitUndo: { files: [undo] } }) }
  } catch (cause) { return failure(command, cause) } finally { await closeRoot(directory) }
}

async function readWorkspaceUndo(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  try {
    const opened = await openPinnedRoot(command, entry); directory = opened.directory
    const request = opened.parsed.request
    if (request.kind !== 'git_undo') throw new CodingWorkspaceError('workspace_invalid_request')
    const signal = AbortSignal.timeout(opened.remaining), git = await guardedGit(repoPath, opened, signal)
    const head = await headSha(git)
    if (head !== request.expected.headSha) throw conflict()
    const planned: { file: typeof request.files.files[number]; observed: ObservedFile; bytes: Buffer | null; done: boolean }[] = []
    for (const file of request.files.files) {
      signal.throwIfAborted()
      if (!visibleWorkspacePath(file.path)) throw new CodingWorkspaceError('workspace_path_unavailable')
      const observed = await observePath(opened.root, file.path)
      if (observed.unsafe) throw new CodingWorkspaceError('workspace_path_unavailable')
      const bytes = file.existed ? Buffer.from(file.base64, 'base64') : null
      if (bytes && (bytes.toString('base64') !== file.base64 || digest(bytes) !== file.sha256)) throw conflict()
      // A retry after a lost receipt may find this file already restored;
      // that is success for this file, not a second write and not a conflict.
      const done = bytes ? observed.exists && observed.contentSha256 === file.sha256 && observed.mode === file.mode : !observed.exists
      if (!done && (observed.exists !== file.after.exists || observed.contentSha256 !== file.after.contentSha256)) throw conflict()
      planned.push({ file, observed, bytes, done })
    }
    // Every fence is proved before the first write.
    for (const { file, observed, bytes, done } of planned) {
      if (done) continue
      if (bytes) await writePinnedFile(opened.root, file.path, bytes, file.mode === '100755', { fence: observed.fence })
      else await deletePinnedFile(opened.root, file.path, observed.fence)
      const after = await observePath(opened.root, file.path)
      if (after.exists !== file.existed || (bytes && after.contentSha256 !== file.sha256)) throw conflict()
    }
    if ((await headSha(git)) !== head) throw conflict()
    const result: WorkspaceGitUndoResult = workspaceGitUndoResult.parse({ ok: true, identity: opened.parsed.identity,
      kind: 'git_undone', operationId: request.operationId, undoOf: request.undoOf, observedAt: new Date().toISOString(),
      availability: 'online', appliedAt: new Date().toISOString(), headSha: head,
      files: planned.map(({ file }) => ({ path: file.path, action: file.existed ? 'restored' as const : 'deleted' as const,
        contentSha256: file.existed ? file.sha256 : null })) })
    return { result, files: [] }
  } catch (cause) { return failure(command, cause) } finally { await closeRoot(directory) }
}

type PlanFile = WorkspaceGitCheckpointPreviewResult['files'][number]
type PlanConflict = WorkspaceGitCheckpointPreviewResult['conflicts'][number]
type RestorePlan = { headSha: string; workingTreeVersion: string; files: PlanFile[]; conflicts: PlanConflict[]
  contents: Map<string, { bytes: Buffer | null; mode: Mode | null }> }

function commonEnv(git: Git) {
  return { ...buildChildEnv({}), GIT_DIR: git.commonDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
}
function tempEnv() {
  return { ...buildChildEnv({}), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
}
const SAFE_GIT = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never']

function runGit(cwd: string, args: string[], env: Record<string, string>, signal: AbortSignal, maximum = 8 * 1024 * 1024) {
  return execa('git', [...SAFE_GIT, ...args], { cwd, env, extendEnv: false, encoding: 'buffer', stripFinalNewline: false,
    stdin: 'ignore', maxBuffer: maximum, cancelSignal: signal, killDescendants: true, timeout: 20_000 })
}

async function readTempFile(worktree: string, path: string): Promise<{ exists: boolean; bytes: Buffer | null; mode: Mode | null; reason: PlanConflict['reason'] | null }> {
  if (!visibleWorkspacePath(path)) throw new CodingWorkspaceError('workspace_path_unavailable')
  const full = join(worktree, ...path.split('/'))
  if (!full.startsWith(`${worktree}/`)) throw new CodingWorkspaceError('workspace_path_unavailable')
  try {
    const stat = await lstat(full)
    if (stat.isSymbolicLink()) return { exists: true, bytes: null, mode: null, reason: 'unavailable' }
    if (stat.isDirectory()) return { exists: true, bytes: null, mode: null, reason: 'submodule' }
    if (!stat.isFile()) return { exists: true, bytes: null, mode: null, reason: 'unavailable' }
    if (stat.size > RESTORE_FILE_BYTES) return { exists: true, bytes: null, mode: null, reason: 'binary' }
    return { exists: true, bytes: await readFile(full), mode: stat.mode & 0o111 ? '100755' : '100644', reason: null }
  } catch (error) {
    if (missing(error)) return { exists: false, bytes: null, mode: null, reason: null }
    throw error
  }
}

/** Git's own 3-way merge in a throwaway worktree is the dry run. The real
 * worktree, index and refs are untouched; only exact resulting bytes are
 * copied after every CAS check passes. */
async function dryRunCheckpoint(git: Git, root: WorkspaceRoot, identity: WorkspaceReadCommand['identity'],
  statusBase: string | null, patchBase: string, patch: Buffer, signal: AbortSignal): Promise<RestorePlan> {
  const head = await headSha(git)
  try { await git(['merge-base', '--is-ancestor', patchBase, head]) }
  catch { throw new CodingWorkspaceError('workspace_unsupported') }
  const parent = await mkdtemp(join(tmpdir(), 'mikka-git-restore-'))
  const worktree = join(parent, 'wt'), patchFile = join(parent, 'checkpoint.patch')
  try {
    await writeFile(patchFile, patch, { mode: 0o600 })
    await runGit(git.commonDir, ['worktree', 'add', '--detach', '--quiet', worktree, head], commonEnv(git), signal)
    let applied = true
    try { await runGit(worktree, ['apply', '--binary', '--3way', '--whitespace=nowarn', patchFile], tempEnv(), signal) }
    catch { applied = false }
    const raw = await runGit(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], tempEnv(), signal)
    const parsed = parsePorcelainV2(raw.stdout.toString())
    const files: PlanFile[] = [], conflicts: PlanConflict[] = [], contents: RestorePlan['contents'] = new Map()
    const seen = new Set<string>()
    let total = 0
    for (const item of parsed.entries) {
      signal.throwIfAborted()
      if (!visibleWorkspacePath(item.path) || (item.previousPath !== null && !visibleWorkspacePath(item.previousPath))) continue
      if (seen.has(item.path)) { conflicts.push({ path: item.path, reason: 'unavailable' }); continue }
      seen.add(item.path)
      if (item.conflicted) { conflicts.push({ path: item.path, reason: 'content' }); continue }
      const previousPath = item.previousPath
      const before = await observePath(root, previousPath ?? item.path)
      if (before.unsafe) { conflicts.push({ path: item.path, reason: 'unavailable' }); continue }
      // A file larger than the bounded observation cannot be proved or
      // captured for Undo, so it is reported instead of half-restored.
      if (before.exists && before.bytes === null) { conflicts.push({ path: item.path, reason: 'binary' }); continue }
      if (previousPath) {
        const destination = await observePath(root, item.path)
        if (destination.exists || destination.unsafe) { conflicts.push({ path: item.path, reason: 'rename' }); continue }
      }
      const target = await readTempFile(worktree, item.path)
      if (target.reason) { conflicts.push({ path: item.path, reason: target.reason }); continue }
      // A create needs its directory chain to exist in the real worktree;
      // discovering that mid-copy would leave the plan half applied.
      if (target.exists && (previousPath !== null || !before.exists) && !await parentDirectoryExists(root, item.path)) {
        conflicts.push({ path: item.path, reason: 'unavailable' }); continue
      }
      total += (target.bytes?.length ?? 0) + (before.bytes?.length ?? 0)
      if (total > RESTORE_SCAN_BYTES) { conflicts.push({ path: item.path, reason: 'unavailable' }); continue }
      const action = previousPath ? 'renamed' as const : !target.exists ? 'deleted' as const
        : !before.exists ? 'added' as const : 'modified' as const
      files.push({ path: item.path, previousPath, action, beforeSha256: before.contentSha256,
        afterSha256: target.exists ? digest(target.bytes!) : null, conflicts: false })
      contents.set(item.path, { bytes: target.bytes, mode: target.mode })
    }
    if (!applied && conflicts.length === 0) throw new CodingWorkspaceError('workspace_unsupported')
    const status = await observeStatus(git, root, identity, statusBase, signal)
    if (status.commitSha !== head) throw conflict()
    return { headSha: head, workingTreeVersion: status.workingTreeVersion, files, conflicts, contents }
  } finally {
    try { await runGit(git.commonDir, ['worktree', 'remove', '--force', worktree], commonEnv(git), AbortSignal.timeout(5_000)) } catch { /* best effort */ }
    await rm(parent, { recursive: true, force: true })
  }
}

function checkpointVersion(request: WorkspaceGitCheckpointPreviewRequest | WorkspaceGitCheckpointRestoreRequest, plan: RestorePlan) {
  return gitCheckpointPreviewVersion({ operationId: request.operationId, checkpointId: request.checkpointId, revision: request.revision,
    patchSha256: request.patchSha256, headSha: plan.headSha, workingTreeVersion: plan.workingTreeVersion,
    files: plan.files, conflicts: plan.conflicts })
}

async function checkpointFacts(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string,
  kind: 'git_checkpoint_preview' | 'git_checkpoint_restore') {
  const opened = await openPinnedRoot(command, entry)
  try {
    const request = opened.parsed.request
    if (request.kind !== kind) throw new CodingWorkspaceError('workspace_invalid_request')
    const signal = AbortSignal.timeout(opened.remaining), git = await guardedGit(repoPath, opened, signal)
    const patch = Buffer.from(request.patchBase64, 'base64')
    if (patch.toString('base64') !== request.patchBase64 || digest(patch) !== request.patchSha256) throw conflict()
    // The server observed HEAD/working tree immediately before this request.
    // A change between that observation and the device dry run is a conflict.
    const current = await observeStatus(git, opened.root, opened.parsed.identity, entry?.baseCommit ?? null, signal)
    if (current.commitSha !== request.expected.headSha || current.workingTreeVersion !== request.expected.workingTreeVersion) throw conflict()
    const plan = await dryRunCheckpoint(git, opened.root, opened.parsed.identity, entry?.baseCommit ?? null,
      request.revision.baseSha, patch, signal)
    return { opened, git, signal, request, plan, version: checkpointVersion(request, plan) }
  } catch (error) { await closeRoot(opened.directory); throw error }
}

async function readCheckpointPreview(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  try {
    const facts = await checkpointFacts(command, entry, repoPath, 'git_checkpoint_preview'); directory = facts.opened.directory
    const result = workspaceGitCheckpointPreviewResult.parse({ ok: true, identity: facts.opened.parsed.identity,
      kind: 'git_checkpoint_preview', operationId: facts.request.operationId, observedAt: new Date().toISOString(), availability: 'online',
      revision: facts.request.revision, headSha: facts.plan.headSha, workingTreeVersion: facts.plan.workingTreeVersion,
      previewVersion: facts.version, clean: facts.plan.conflicts.length === 0 && facts.plan.files.every(file => !file.conflicts),
      files: facts.plan.files, conflicts: facts.plan.conflicts })
    return { result, files: [] }
  } catch (cause) { return failure(command, cause) } finally { await closeRoot(directory) }
}

async function readCheckpointRestore(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  try {
    const facts = await checkpointFacts(command, entry, repoPath, 'git_checkpoint_restore'); directory = facts.opened.directory
    const request = facts.request as WorkspaceGitCheckpointRestoreRequest
    if (facts.version !== request.previewVersion) throw conflict()
    if (facts.plan.conflicts.length || facts.plan.files.some(file => file.conflicts))
      throw new CodingWorkspaceError('workspace_version_conflict')
    const before = new Map<string, ObservedFile>()
    const undoFiles: GitUndoFile[] = []
    let undoPossible = true
    // Prove every current file first; a later mismatch must not leave an
    // earlier target silently changed.
    for (const file of facts.plan.files) {
      facts.signal.throwIfAborted()
      const current = await observePath(facts.opened.root, file.previousPath ?? file.path)
      if (current.unsafe) throw new CodingWorkspaceError('workspace_path_unavailable')
      if (current.exists !== (file.beforeSha256 !== null) || current.contentSha256 !== file.beforeSha256) throw conflict()
      before.set(file.path, current)
    }
    for (const file of facts.plan.files) {
      const current = before.get(file.path)!
      if (current.exists && !current.bytes) undoPossible = false
      if (file.action === 'deleted') {
        await deletePinnedFile(facts.opened.root, file.path, current.fence)
      } else {
        const content = facts.plan.contents.get(file.path)
        if (!content?.bytes) throw conflict()
        await writePinnedFile(facts.opened.root, file.path, content.bytes, content.mode === '100755',
          file.action === 'added' || file.action === 'renamed' ? { createOnly: true } : { fence: current.fence })
      }
      const after = await observePath(facts.opened.root, file.path)
      if (after.contentSha256 !== file.afterSha256) throw conflict()
      const push = (entry: (typeof undoFiles)[number]) => {
        if (undoFiles.some(item => item.path === entry.path)) { undoPossible = false; return }
        undoFiles.push(entry)
      }
      if (file.action === 'renamed' && file.previousPath) {
        if (current.bytes) {
          push({ path: file.path, existed: false, mode: null, base64: '', sha256: digest(''),
            after: { exists: true, contentSha256: after.contentSha256 } })
          push({ path: file.previousPath, existed: true, mode: current.mode, base64: current.bytes.toString('base64'),
            sha256: current.contentSha256!, after: { exists: false, contentSha256: null } })
        } else undoPossible = false
      } else if (current.exists) {
        if (current.bytes) {
          push({ path: file.path, existed: true, mode: current.mode, base64: current.bytes.toString('base64'),
            sha256: current.contentSha256!, after: { exists: after.exists, contentSha256: after.contentSha256 } })
        }
      } else {
        push({ path: file.path, existed: false, mode: null, base64: '', sha256: digest(''),
          after: { exists: after.exists, contentSha256: after.contentSha256 } })
      }
    }
    const status = await observeStatus(facts.git, facts.opened.root, facts.opened.parsed.identity, entry?.baseCommit ?? null, facts.signal)
    if (status.commitSha !== facts.plan.headSha) throw conflict()
    const totalUndo = undoFiles.reduce((bytes, file) => bytes + file.base64.length / 4 * 3 -
      (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0), 0)
    const undo = undoPossible && undoFiles.length > 0 && undoFiles.length <= WORKSPACE_GIT_MAX_UNDO_FILES && totalUndo <= WORKSPACE_GIT_MAX_UNDO_BYTES
      ? { files: undoFiles } : undefined
    const result = workspaceGitCheckpointRestoreResult.parse({ ok: true, identity: facts.opened.parsed.identity,
      kind: 'git_checkpoint_restored', operationId: request.operationId, previewVersion: request.previewVersion,
      observedAt: new Date().toISOString(), availability: 'online', appliedAt: new Date().toISOString(),
      headSha: facts.plan.headSha, workingTreeVersion: status.workingTreeVersion, checkpointId: request.checkpointId,
      files: facts.plan.files, idempotent: false })
    return { result, files: [], ...(undo ? { gitUndo: undo } : {}) }
  } catch (cause) { return failure(command, cause) } finally { await closeRoot(directory) }
}

/** One receipt entry point for every Git command on the device. Read kinds
 * prove facts; write kinds re-check HEAD, exact content fences and the
 * confirmed preview before touching a single byte. */
export async function handleWorkspaceGitRequest(command: WorkspaceReadCommand, entry: JournalEntry | undefined, repoPath: string): Promise<WorkspaceReadReceipt> {
  const parsed = workspaceReadCommand.safeParse(command)
  if (!parsed.success) return { result: { ok: false, code: 'workspace_invalid_request' }, files: [] }
  switch (parsed.data.request.kind) {
    case 'git_status': return readGitStatus(command, entry, repoPath)
    case 'git_history': return readGitHistory(command, entry, repoPath)
    case 'git_revert_preview': return readWorkspaceRevertPreview(command, entry, repoPath)
    case 'git_revert_apply': return readWorkspaceRevertApply(command, entry, repoPath)
    case 'git_undo': return readWorkspaceUndo(command, entry, repoPath)
    case 'git_checkpoint_preview': return readCheckpointPreview(command, entry, repoPath)
    case 'git_checkpoint_restore': return readCheckpointRestore(command, entry, repoPath)
    default: return { result: { ok: false, code: 'workspace_invalid_request' }, files: [] }
  }
}
