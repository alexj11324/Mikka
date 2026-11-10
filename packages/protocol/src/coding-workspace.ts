import { z } from 'zod'

/** Shared by Files, Diff, Git, Terminal and the editor. Paths are never machine roots. */
export const WORKSPACE_PROTOCOL_VERSION = 1
export const WORKSPACE_REQUEST_HEADER = 'x-mikka-coding-workspace'
export const WORKSPACE_MAX_FILE_BYTES = 1024 * 1024
export const WORKSPACE_MAX_RESPONSE_BYTES = 256 * 1024
export const WORKSPACE_MAX_PATHS = 20_000
export const WORKSPACE_REQUEST_TTL_MS = 15_000
export const WORKSPACE_MENTION_TTL_MS = 10 * 60_000

export const workspacePath = z.string().max(1024).refine(value => value === '' || (
  !/[\\\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('/') &&
  !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
), 'Expected a repository-relative path')

const safeDotfiles = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.prettierignore', '.prettierrc', '.eslintrc', '.dockerignore'])
const safeDotdirs = new Set(['.github', '.vscode'])
const forbiddenPath = /^(?:node_modules|\.git|\.ssh|\.aws|\.azure|\.config|\.claude|\.codex|\.mikka|\.gnupg|\.kube|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.env(?:\..*)?|(?:credentials|secrets?)(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?)$/i
const privateExtension = /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i

/** One path policy at API admission, receipt validation and the actual reader.
 * Being tracked by Git never exempts a credential or hidden path. */
export function visibleWorkspacePath(path: string): boolean {
  if (!workspacePath.safeParse(path).success) return false
  return path.split('/').every((part, index, parts) => !forbiddenPath.test(part) && !privateExtension.test(part) &&
    (!part.startsWith('.') || (index < parts.length - 1 ? safeDotdirs.has(part) : safeDotfiles.has(part) || safeDotdirs.has(part))))
}
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const runWorktreeIdentity = z.strictObject({
  version: z.literal(1), runId: z.uuid(), repoId: z.uuid(), deviceId: z.uuid(),
  workspaceId: z.uuid(), ownerId: z.string().min(1).max(128),
  repositoryKey: z.string().min(1).max(4000), bindingId: digest,
})
export type RunWorktreeIdentity = z.infer<typeof runWorktreeIdentity>

export const sourceRevision = z.strictObject({
  source: z.enum(['working', 'checkpoint', 'commit', 'pull_request']),
  headSha: sha, baseSha: sha.nullable(), version: digest,
})
export type SourceRevision = z.infer<typeof sourceRevision>
export const fileRange = z.strictObject({ startLine: z.number().int().min(1).max(1_000_000), endLine: z.number().int().min(1).max(1_000_000) })
  .refine(value => value.endLine >= value.startLine && value.endLine - value.startLine < 2000)
const expected = z.strictObject({ headSha: sha, contentSha256: digest })
export const workspaceFileSelection = z.strictObject({ path: workspacePath.refine(Boolean), range: fileRange.optional(), expected: expected.optional() })
export type WorkspaceFileSelection = z.infer<typeof workspaceFileSelection>
export const workspaceContextSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: workspacePath.refine(Boolean), range: fileRange.optional() }),
  z.strictObject({ kind: z.literal('folder'), path: workspacePath }),
  z.strictObject({ kind: z.literal('resolved'), files: z.array(workspaceFileSelection).min(1).max(20) }),
])

export const workspaceReadRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tree'), path: workspacePath.default(''), cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(200).default(100) }),
  z.strictObject({ kind: z.literal('file'), path: workspacePath.refine(Boolean), range: fileRange.optional(), expected: expected.optional() }),
  z.strictObject({ kind: z.literal('search'), query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).default(30) }),
  z.strictObject({ kind: z.literal('context'), selection: workspaceContextSelection }),
])
export type WorkspaceReadRequest = z.infer<typeof workspaceReadRequest>

export function workspaceRequestPathsAllowed(request: WorkspaceReadRequest): boolean {
  if (request.kind === 'search') return true
  if (request.kind !== 'context') return visibleWorkspacePath(request.path)
  return request.selection.kind === 'resolved' ? request.selection.files.every(file => visibleWorkspacePath(file.path))
    : visibleWorkspacePath(request.selection.path)
}

export const WORKSPACE_ERROR_CODES = [
  'workspace_not_found', 'workspace_machine_unavailable', 'workspace_checkout_unavailable',
  'workspace_path_unavailable', 'workspace_version_conflict', 'workspace_limit_exceeded',
  'workspace_request_expired', 'workspace_unsupported', 'workspace_invalid_request',
] as const
export type WorkspaceErrorCode = typeof WORKSPACE_ERROR_CODES[number]
export const workspaceFailure = z.strictObject({ ok: z.literal(false), code: z.enum(WORKSPACE_ERROR_CODES) })
export type WorkspaceFailure = z.infer<typeof workspaceFailure>

export const workspaceEntry = z.strictObject({
  path: workspacePath, name: z.string().min(1).max(255), kind: z.enum(['directory', 'file']),
  size: z.number().int().nonnegative().nullable(),
})
export type WorkspaceEntry = z.infer<typeof workspaceEntry>
const observation = {
  ok: z.literal(true), identity: runWorktreeIdentity, revision: sourceRevision,
  observedAt: z.iso.datetime(), availability: z.literal('online'),
}
export const workspaceFileResult = z.strictObject({ ...observation, kind: z.literal('file'), path: workspacePath, size: z.number().int().nonnegative(),
    format: z.enum(['text', 'binary', 'too_large', 'unsupported']), content: z.string().max(WORKSPACE_MAX_RESPONSE_BYTES).nullable(),
    contentSha256: digest.nullable(), language: z.string().max(40).nullable(),
    startLine: z.number().int().positive(), endLine: z.number().int().nonnegative(), totalLines: z.number().int().nonnegative().nullable(),
    truncated: z.boolean(), editable: z.literal(false),
  })
export const workspaceReadResult = z.union([
  workspaceFailure,
  workspaceFileResult,
  z.strictObject({ ...observation, kind: z.literal('tree'), path: workspacePath, entries: z.array(workspaceEntry).max(200), nextCursor: z.string().max(256).nullable(), truncated: z.boolean() }),
  z.strictObject({ ...observation, kind: z.literal('search'), entries: z.array(workspaceEntry).max(100), truncated: z.boolean() }),
  z.strictObject({ ...observation, kind: z.literal('context'), files: z.array(workspaceFileResult).min(1).max(20), omitted: z.number().int().nonnegative() }),
])
export type WorkspaceReadResult = z.infer<typeof workspaceReadResult>
export type WorkspaceFileResult = Extract<WorkspaceReadResult, { kind: 'file' }>

/** Private device-to-server validation envelope. Whole file bytes are checked
 * for secrets before any selected range may leave the server. They must never
 * be stored in a request result, a mention or a public API response. */
const validationFile = z.strictObject({
  path: workspacePath.refine(Boolean),
  base64: z.string().max(Math.ceil(WORKSPACE_MAX_FILE_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})
export const workspaceReadReceipt = z.strictObject({
  result: workspaceReadResult,
  files: z.array(validationFile).max(20),
}).refine(value => value.files.reduce((bytes, file) => bytes + file.base64.length / 4 * 3 -
  (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0), 0) <= WORKSPACE_MAX_FILE_BYTES)
export type WorkspaceReadReceipt = z.infer<typeof workspaceReadReceipt>

/** Match a device receipt to the exact authorized request. Nested files must
 * carry the same binding and observation, never a second run/repository. */
export function matchesWorkspaceResponse(request: WorkspaceReadRequest, identity: RunWorktreeIdentity, result: WorkspaceReadResult): boolean {
  if (!result.ok) return true
  const sameIdentity = (value: RunWorktreeIdentity) => Object.keys(identity).every(key =>
    value[key as keyof RunWorktreeIdentity] === identity[key as keyof RunWorktreeIdentity])
  if (!sameIdentity(result.identity) || result.kind !== request.kind || result.revision.source !== 'working' || !workspaceRequestPathsAllowed(request)) return false
  const fileMatches = (file: WorkspaceFileResult, selection: WorkspaceFileSelection) => {
    if (!sameIdentity(file.identity) || file.path !== selection.path || file.revision.source !== 'working' || !visibleWorkspacePath(file.path)) return false
    if (selection.expected && (file.revision.headSha !== selection.expected.headSha || file.contentSha256 !== selection.expected.contentSha256)) return false
    if (file.format !== 'text') return file.content === null
    return file.content !== null && file.contentSha256 !== null && file.totalLines !== null &&
      new TextEncoder().encode(file.content).byteLength <= WORKSPACE_MAX_RESPONSE_BYTES &&
      file.startLine === (selection.range?.startLine ?? 1) && file.endLine >= file.startLine &&
      file.endLine <= Math.min(selection.range?.endLine ?? 2000, file.totalLines) &&
      file.content.split('\n').length === file.endLine - file.startLine + 1
  }
  if (result.kind === 'file' && request.kind === 'file') return fileMatches(result, request)
  if (result.kind === 'tree' && request.kind === 'tree') {
    const prefix = request.path ? `${request.path}/` : ''
    return result.path === request.path && result.entries.length <= request.limit && result.entries.every(entry =>
      entry.path === `${prefix}${entry.name}` && !entry.name.includes('/') && visibleWorkspacePath(entry.path))
  }
  if (result.kind === 'search' && request.kind === 'search') return result.entries.length <= request.limit &&
    result.entries.every(entry => entry.path.toLowerCase().includes(request.query.toLowerCase()) && visibleWorkspacePath(entry.path))
  if (result.kind === 'context' && request.kind === 'context') {
    const selection = request.selection
    const files = selection.kind === 'resolved' ? selection.files : selection.kind === 'file' ? [selection] : null
    if (files && (files.length !== result.files.length || result.omitted !== 0)) return false
    let bytes = 0
    return result.files.every((file, index) => {
      bytes += new TextEncoder().encode(file.content ?? '').byteLength
      return file.format === 'text' && bytes <= 64 * 1024 && file.revision.headSha === result.revision.headSha &&
        (files ? fileMatches(file, files[index]!) : selection.kind === 'folder' &&
          (!selection.path || file.path.startsWith(`${selection.path}/`)) && fileMatches(file, { path: file.path }))
    })
  }
  return false
}

/** Delivered through the existing device work wake; no client-selected root or sandbox. */
export const workspaceReadCommand = z.strictObject({
  id: z.uuid(), identity: runWorktreeIdentity, request: workspaceReadRequest, expiresAt: z.iso.datetime(),
})
export type WorkspaceReadCommand = z.infer<typeof workspaceReadCommand>

export class CodingWorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'CodingWorkspaceError' }
}
