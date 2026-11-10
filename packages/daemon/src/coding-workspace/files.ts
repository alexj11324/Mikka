import { constants } from 'node:fs'
import { open, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { extname, resolve } from 'node:path'
import {
  CodingWorkspaceError, WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_PATHS, WORKSPACE_MAX_RESPONSE_BYTES,
  visibleWorkspacePath, workspaceReadCommand, type WorkspaceReadCommand, type WorkspaceReadRequest,
  type WorkspaceReadResult, type WorkspaceReadReceipt, type WorkspaceEntry, type WorkingSourceRevision, type WorkspaceFileSelection, type WorkspaceFileResult,
} from '@mikka/protocol/coding-workspace'
import { remoteKey } from '@mikka/protocol/repository'
import type { JournalEntry } from '../runs/journal'
import { buildChildEnv } from '../env'

const execute = promisify(execFile)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const denied = () => new CodingWorkspaceError('workspace_path_unavailable')
type FileReadRequest = Extract<WorkspaceReadRequest, { kind: 'file' | 'tree' | 'search' | 'context' }>
/** Diff and Git requests have their own readers; this one owns source reads. */
function isFileReadRequest(request: WorkspaceReadRequest): request is FileReadRequest {
  return request.kind === 'file' || request.kind === 'tree' || request.kind === 'search' || request.kind === 'context'
}
// These paths remain forbidden even when Git tracks them. Dotfiles are opt-in.
const safeDotfiles = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.prettierignore', '.prettierrc', '.eslintrc', '.dockerignore'])
export type WorkspaceRoot = { path: string; handle: FileHandle; device: bigint; mountId: string; gitPath: string }

export async function mountId(handle: FileHandle): Promise<string> {
  const id = /^mnt_id:\s*(\d+)$/m.exec(await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8'))?.[1]
  if (!id) throw new CodingWorkspaceError('workspace_unsupported')
  return id
}

async function git(root: WorkspaceRoot, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      // chdir resolves the parent's open directory before exec closes FDs.
      // /proc/self works even when the visible procfs uses another PID namespace.
      cwd: root.gitPath, timeout: 5000, maxBuffer, env: { ...buildChildEnv({}), NODE_ENV: process.env.NODE_ENV ?? 'production',
        GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    return stdout
  } catch (cause) { throw new CodingWorkspaceError('workspace_checkout_unavailable', { cause }) }
}

/** Linux: each segment is opened relative to an already-open directory. A
 * concurrent symlink/parent rename never makes the next lookup follow a new
 * absolute pathname. Other platforms fail closed until an equivalent exists. */
export async function safeFile<T>(root: WorkspaceRoot, path: string, use: (file: FileHandle) => Promise<T>): Promise<T> {
  if (!visibleWorkspacePath(path) || !path) throw denied()
  const handles: FileHandle[] = []
  try {
    let parent = root.handle
    const parts = path.split('/')
    for (let index = 0; index < parts.length; index++) {
      const directory = index < parts.length - 1
      const handle = await open(`/proc/self/fd/${parent.fd}/${parts[index]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0))
      handles.push(handle)
      const stat = await handle.stat({ bigint: true })
      // st_dev alone misses bind mounts of another directory on the same
      // filesystem. Linux's descriptor mount ID fences those as well.
      if (stat.dev !== root.device || await mountId(handle) !== root.mountId ||
        (!directory && (!stat.isFile() || stat.nlink !== 1n))) throw denied()
      parent = handle
    }
    // Recheck the still-visible path, including parents, before and after use.
    const selected = await realpath(`/proc/self/fd/${parent.fd}`)
    if (selected !== resolve(root.path, path) || await realpath(root.gitPath) !== root.path) throw denied()
    const result = await use(parent)
    if (await realpath(`/proc/self/fd/${parent.fd}`) !== selected || await realpath(resolve(root.path, path)) !== selected ||
      await realpath(root.gitPath) !== root.path) throw new CodingWorkspaceError('workspace_version_conflict')
    return result
  } catch (cause) {
    if (cause instanceof CodingWorkspaceError) throw cause
    throw new CodingWorkspaceError('workspace_path_unavailable', { cause })
  } finally { await Promise.all(handles.map(handle => handle.close())) }
}

const textExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.mdx', '.txt', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.sass', '.less', '.sql', '.py', '.pyi', '.go', '.mod', '.sum', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.vue', '.svelte', '.graphql', '.gql', '.proto', '.prisma', '.ex', '.exs', '.erl', '.hrl', '.clj', '.scala', '.r', '.rmd', '.jl', '.lua', '.pl', '.pm', '.dart', '.lock', '.ini', '.conf', '.cfg', '.rst', '.adoc', '.tex'])
const textNames = /^(?:Dockerfile(?:\..*)?|Containerfile|Makefile|CMakeLists\.txt|README(?:\..*)?|LICENSE(?:\..*)?|NOTICE|Procfile|Gemfile|Rakefile|Justfile)$/i
function isText(path: string) { return textExtensions.has(extname(path).toLowerCase()) || textNames.test(path.split('/').at(-1)!) || safeDotfiles.has(path.split('/').at(-1)!) }
function revision(headSha: string, baseSha: string | undefined, content: string | Buffer): WorkingSourceRevision {
  return { source: 'working', headSha, baseSha: baseSha && /^[a-f0-9]{40,64}$/.test(baseSha) ? baseSha : null, version: hash(content) }
}

async function inventory(root: WorkspaceRoot) {
  const output = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  const paths = [...new Set(output.split('\0').filter(Boolean))]
  if (paths.length > WORKSPACE_MAX_PATHS) throw new CodingWorkspaceError('workspace_limit_exceeded')
  return paths.filter(visibleWorkspacePath).sort()
}

/** Authority is the already-claimed local journal, never the request's path. */
export async function readWorkspace(command: WorkspaceReadCommand, entry: JournalEntry | undefined): Promise<WorkspaceReadResult> {
  return (await readWorkspaceReceipt(command, entry)).result
}

export async function readWorkspaceReceipt(command: WorkspaceReadCommand, entry: JournalEntry | undefined): Promise<WorkspaceReadReceipt> {
  let directory: FileHandle | undefined
  const validation = new Map<string, Buffer>()
  let validationBytes = 0
  try {
    const input = workspaceReadCommand.safeParse(command)
    if (!input.success) throw new CodingWorkspaceError('workspace_invalid_request', { cause: input.error })
    const parsed = input.data
    if (Date.parse(parsed.expiresAt) <= Date.now()) throw new CodingWorkspaceError('workspace_request_expired')
    const { identity, request } = parsed
    if (!isFileReadRequest(request)) throw new CodingWorkspaceError('workspace_unsupported')
    if (!entry?.worktree || entry.assignment.runId !== identity.runId || entry.assignment.deviceId !== identity.deviceId || entry.assignment.repoId !== identity.repoId)
      throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const remote = entry.assignment.remoteUrl ?? entry.assignment.expectedRepoRemote
    if (!remote || remoteKey(remote) !== identity.repositoryKey) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    if (process.platform !== 'linux') throw new CodingWorkspaceError('workspace_unsupported')
    const path = resolve(entry.worktree)
    if (await realpath(path) !== path) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    // Pin the directory for Git and every file open for this entire operation.
    // Replacing the journal pathname cannot switch us to a second checkout.
    const root: WorkspaceRoot = { path, handle: directory, device: (await directory.stat({ bigint: true })).dev, mountId: await mountId(directory),
      gitPath: `/proc/self/fd/${directory.fd}` }
    if ((await git(root, ['rev-parse', '--show-toplevel'])).trim() !== root.path || remoteKey((await git(root, ['config', '--get', 'remote.origin.url'])).trim()) !== identity.repositoryKey)
      throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const headSha = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headSha)) throw new CodingWorkspaceError('workspace_checkout_unavailable')
    const paths = await inventory(root)
    const observation = { ok: true as const, identity, observedAt: new Date().toISOString(), availability: 'online' as const }
    let result: WorkspaceReadResult
    const readOne = async (request: WorkspaceFileSelection): Promise<WorkspaceFileResult> => {
      if (!paths.includes(request.path)) throw new CodingWorkspaceError(request.expected ? 'workspace_version_conflict' : 'workspace_path_unavailable')
      if (request.expected && request.expected.headSha !== headSha) throw new CodingWorkspaceError('workspace_version_conflict')
      return safeFile(root, request.path, async file => {
        const before = await file.stat({ bigint: true })
        const size = Number(before.size)
        const base = { ...observation, kind: 'file' as const, path: request.path, size, language: extname(request.path).slice(1) || null,
          revision: revision(headSha, entry.baseCommit, `${headSha}:${request.path}:${before.ino}:${before.mtimeNs}:${before.ctimeNs}:${before.size}`),
          content: null, contentSha256: null, startLine: request.range?.startLine ?? 1, endLine: 0, totalLines: null, truncated: false, editable: false as const }
        if (size > WORKSPACE_MAX_FILE_BYTES) {
          if (request.expected) throw new CodingWorkspaceError('workspace_version_conflict')
          return { ...base, format: 'too_large' as const }
        }
        const bytes = Buffer.alloc(size + 1)
        const { bytesRead } = await file.read(bytes, 0, size + 1, 0)
        const after = await file.stat({ bigint: true })
        if (bytesRead !== size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) throw new CodingWorkspaceError('workspace_version_conflict')
        const contents = bytes.subarray(0, size)
        const contentSha256 = hash(contents)
        if (request.expected && (request.expected.headSha !== headSha || request.expected.contentSha256 !== contentSha256)) throw new CodingWorkspaceError('workspace_version_conflict')
        const versioned = { ...base, contentSha256, revision: revision(headSha, entry.baseCommit, `${headSha}:${request.path}:${contentSha256}`) }
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents) }
        catch { return { ...versioned, format: 'binary' as const } }
        if (text.includes('\0')) return { ...versioned, format: 'binary' as const }
        if (!isText(request.path)) return { ...versioned, format: 'unsupported' as const }
        const lines = text.split('\n')
        const start = request.range?.startLine ?? 1
        if (start > lines.length) throw new CodingWorkspaceError('workspace_invalid_request')
        const maximum = Math.min(request.range?.endLine ?? 2000, lines.length)
        const selected: string[] = []
        let end = start - 1, selectedBytes = 0
        for (; end < maximum; end++) {
          const line = lines[end]!, length = Buffer.byteLength(line) + Number(selected.length > 0)
          if (selectedBytes + length > WORKSPACE_MAX_RESPONSE_BYTES) break
          selected.push(line); selectedBytes += length
        }
        if (!selected.length) throw new CodingWorkspaceError('workspace_limit_exceeded')
        const content = selected.join('\n')
        const prior = validation.get(request.path)
        if (prior && !prior.equals(contents)) throw new CodingWorkspaceError('workspace_version_conflict')
        if (!prior) {
          validationBytes += contents.length
          if (validationBytes > WORKSPACE_MAX_FILE_BYTES) throw new CodingWorkspaceError('workspace_limit_exceeded')
          validation.set(request.path, contents)
        }
        return { ...versioned, format: 'text' as const, content, startLine: start, endLine: end, totalLines: lines.length, truncated: start > 1 || end < lines.length }
      }).catch(cause => {
        if (request.expected && cause instanceof CodingWorkspaceError && cause.code === 'workspace_path_unavailable')
          throw new CodingWorkspaceError('workspace_version_conflict', { cause })
        throw cause
      })
    }
    if (request.kind === 'file') result = await readOne(request)
    else if (request.kind === 'context') {
      const selection = request.selection
      const selected: WorkspaceFileSelection[] = selection.kind === 'resolved' ? selection.files : selection.kind === 'file' ? [selection]
        : paths.filter(path => (!selection.path || path.startsWith(`${selection.path}/`)) && isText(path)).map(path => ({ path }))
      if (!selected.length) throw denied()
      if (selected.length > 20) throw new CodingWorkspaceError('workspace_limit_exceeded')
      const files: WorkspaceFileResult[] = []
      let bytes = 0, omitted = 0
      for (const item of selected) {
        const file = await readOne(item)
        if (file.format !== 'text' || file.content === null) {
          if (selection.kind !== 'folder') throw new CodingWorkspaceError('workspace_unsupported')
          omitted++; continue
        }
        bytes += Buffer.byteLength(file.content)
        if (bytes > 64 * 1024) throw new CodingWorkspaceError('workspace_limit_exceeded')
        files.push(file)
      }
      if (!files.length) throw new CodingWorkspaceError('workspace_unsupported')
      result = { ...observation, kind: 'context', revision: revision(headSha, entry.baseCommit, JSON.stringify(files.map(file => [file.path, file.contentSha256]))), files, omitted }
    } else {
      const entries = new Map<string, WorkspaceEntry>()
      for (const path of paths) {
        if (request.kind === 'search') {
          if (path.toLowerCase().includes(request.query.toLowerCase())) entries.set(path, { path, name: path.split('/').at(-1)!, kind: 'file', size: null })
        } else {
          const prefix = request.path ? `${request.path}/` : ''
          if (!path.startsWith(prefix)) continue
          const rest = path.slice(prefix.length), name = rest.split('/')[0]!
          entries.set(`${prefix}${name}`, { path: `${prefix}${name}`, name, kind: rest.includes('/') ? 'directory' : 'file', size: null })
        }
      }
      if (request.kind === 'tree' && request.path && (!visibleWorkspacePath(request.path) || !entries.size)) throw denied()
      const values = [...entries.values()].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.path.localeCompare(b.path))
      const current = revision(headSha, entry.baseCommit, JSON.stringify([headSha, values]))
      let offset = 0
      if (request.kind === 'tree' && request.cursor) {
        const match = /^([a-f0-9]{64}):([0-9]{1,8})$/.exec(request.cursor)
        if (!match || match[1] !== current.version) throw new CodingWorkspaceError('workspace_version_conflict')
        offset = Number(match[2])
        if (offset > values.length) throw new CodingWorkspaceError('workspace_invalid_request')
      }
      const page: WorkspaceEntry[] = []
      let pageBytes = 2048 // identity/revision/cursor and observation overhead
      for (const value of values.slice(offset, offset + request.limit)) {
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (pageBytes + bytes > WORKSPACE_MAX_RESPONSE_BYTES) break
        pageBytes += bytes
        // Metadata comes from the same pinned descriptor as file reads. An
        // unreadable/link entry has no size; listing never follows its target.
        if (value.kind === 'file') {
          try { value.size = await safeFile(root, value.path, async file => (await file.stat()).size) }
          catch (error) { if (!(error instanceof CodingWorkspaceError)) throw error }
        }
        page.push(value)
      }
      const truncated = offset + page.length < values.length
      result = request.kind === 'tree'
        ? { ...observation, revision: current, kind: 'tree', path: request.path, entries: page, truncated, nextCursor: truncated ? `${current.version}:${offset + page.length}` : null }
        : { ...observation, revision: current, kind: 'search', entries: page, truncated }
    }
    if ((await git(root, ['rev-parse', '--verify', 'HEAD'])).trim() !== headSha || await realpath(root.gitPath) !== root.path)
      throw new CodingWorkspaceError('workspace_version_conflict')
    if (Date.parse(parsed.expiresAt) <= Date.now()) throw new CodingWorkspaceError('workspace_request_expired')
    return { result, files: [...validation].map(([path, bytes]) => ({ path, base64: bytes.toString('base64') })) }
  } catch (cause) {
    return { result: { ok: false, code: cause instanceof CodingWorkspaceError ? cause.code : 'workspace_checkout_unavailable' }, files: [] }
  } finally { await directory?.close() }
}
