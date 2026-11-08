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
  // Legacy checkpoints retained their base and patch, not the HEAD at capture.
  headSha: sha.nullable(), baseSha: sha.nullable(), version: digest,
})
export type SourceRevision = z.infer<typeof sourceRevision>
export const workingSourceRevision = sourceRevision.extend({ source: z.literal('working'), headSha: sha })
export type WorkingSourceRevision = z.infer<typeof workingSourceRevision>
