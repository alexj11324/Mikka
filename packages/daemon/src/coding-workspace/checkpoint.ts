import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { execa } from 'execa'
import { visibleWorkspacePath } from '@mikka/protocol/coding-workspace'
import { CHECKPOINT_REVIEW_MAX_PROOF_BYTES, WORKSPACE_DIFF_MAX_BLOB_BYTES, WORKSPACE_DIFF_MAX_FILES,
  diffFileVersionMaterial, type CheckpointReviewEvidence, type DiffFileMetadata, type DiffRevision } from '@mikka/protocol/coding-workspace-review'
import { worktreeGitDir } from '../agents/publish'
import { buildChildEnv } from '../env'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const MANIFEST_BYTES = 1536 * 1024
type Change = { path: string; previousPath: string | null; oldBlob: string | null; newBlob: string | null;
  oldMode: string | null; newMode: string | null }
const regular = (mode: string | null) => mode === null || mode === '100644' || mode === '100755'

/** Consume the already captured immutable tree. This path never scans the
 * working filesystem, stages files, runs a filter or writes another object. */
export async function captureCheckpointReview(input: {
  repoPath: string; worktree: string; repoId: string; baseSha: string; headSha: string | null; treeSha: string;
}): Promise<CheckpointReviewEvidence> {
  const revision: DiffRevision & { source: 'checkpoint'; baseSha: string; treeSha: string } = {
    source: 'checkpoint', baseSha: input.baseSha, headSha: input.headSha, treeSha: input.treeSha, version: '0'.repeat(64),
  }
  const result = (files: DiffFileMetadata[], blobs: CheckpointReviewEvidence['blobs'], reason: CheckpointReviewEvidence['reason']): CheckpointReviewEvidence => ({
    version: 1, repoId: input.repoId, revision: { ...revision,
      version: digest(JSON.stringify([revision.source, revision.baseSha, revision.headSha, revision.treeSha, files.map(file => file.fileVersion)])) },
    files, blobs, reason,
  })
  if (!input.headSha) return result([], [], 'version_changed')
  if (![input.baseSha, input.headSha, input.treeSha].every(value => oid.test(value))) return result([], [], 'missing_evidence')
  let exceeded = false
  try {
    const signal = AbortSignal.timeout(4000)
    const gitDir = await worktreeGitDir(input.repoPath, input.worktree, signal)
    const env = { ...buildChildEnv({}), GIT_DIR: gitDir, GIT_COMMON_DIR: resolve(gitDir, '..', '..'), GIT_WORK_TREE: input.worktree,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }
    const git = async (args: string[], text?: string, maximum = MANIFEST_BYTES) => {
      signal.throwIfAborted()
      const child = await execa('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'protocol.ext.allow=never', ...args], { cwd: input.repoPath, env, extendEnv: false,
        encoding: 'buffer', stripFinalNewline: false, ...(text === undefined ? { stdin: 'ignore' as const } : { input: text }),
        maxBuffer: maximum, cancelSignal: signal, killDescendants: true })
      return Buffer.from(child.stdout)
    }
    const raw = await git(['diff-tree', '--no-commit-id', '--raw', '-z', '-r', '--no-abbrev', '--no-renames',
      '--no-ext-diff', '--no-textconv', input.baseSha, input.treeSha])
    const parts = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).split('\0')
    if (parts.pop() !== '' || parts.length % 2) return result([], [], 'missing_evidence')
    const changes: Change[] = []
    for (let i = 0; i < parts.length; i += 2) {
      const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([a-f0-9]{40}(?:[a-f0-9]{24})?) [AMDT]$/.exec(parts[i]!)
      if (!match) return result([], [], 'unsupported')
      const path = parts[i + 1]!
      if (!visibleWorkspacePath(path)) continue
      changes.push({ path, previousPath: null, oldBlob: /^0+$/.test(match[3]!) ? null : match[3]!,
        newBlob: /^0+$/.test(match[4]!) ? null : match[4]!, oldMode: match[1] === '000000' ? null : match[1]!,
        newMode: match[2] === '000000' ? null : match[2]! })
    }
    if (changes.length > WORKSPACE_DIFF_MAX_FILES) return result([], [], 'too_large')
    const removed = new Map<string, Change[]>()
    for (const file of changes) if (!file.newBlob && file.oldBlob) {
      const key = `${file.oldMode}:${file.oldBlob}`, entries = removed.get(key) ?? []
      entries.push(file); removed.set(key, entries)
    }
    const consumed = new Set<string>()
    for (const file of changes) if (!file.oldBlob && file.newBlob) {
      const matches = removed.get(`${file.newMode}:${file.newBlob}`)
      if (matches?.length === 1 && !consumed.has(matches[0]!.path)) {
        const old = matches[0]!
        file.previousPath = old.path; file.oldBlob = old.oldBlob; file.oldMode = old.oldMode; consumed.add(old.path)
      }
    }
    const selected = changes.filter(file => !consumed.has(file.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const objects = [...new Set(selected.flatMap(file => [
      ...(file.oldBlob && regular(file.oldMode) ? [file.oldBlob] : []),
      ...(file.newBlob && regular(file.newMode) ? [file.newBlob] : []),
    ]))]
    const sizes = new Map<string, number>()
    if (objects.length) {
      const checked = (await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], objects.join('\n') + '\n', 4 * 1024 * 1024))
        .toString('ascii').trim().split('\n')
      if (checked.length !== objects.length) return result([], [], 'missing_evidence')
      for (const [i, row] of checked.entries()) {
        const match = /^([a-f0-9]+) blob ([0-9]+)$/.exec(row)
        if (!match || match[1] !== objects[i] || !Number.isSafeInteger(Number(match[2]))) return result([], [], 'missing_evidence')
        sizes.set(match[1], Number(match[2]))
      }
    }
    const files: DiffFileMetadata[] = selected.map(change => {
      const file = { ...change, status: !regular(change.oldMode) || !regular(change.newMode) ? 'unavailable' as const
        : change.previousPath ? 'renamed' as const : !change.oldBlob ? 'added' as const : !change.newBlob ? 'deleted' as const : 'modified' as const,
      oldSize: change.oldBlob ? sizes.get(change.oldBlob) ?? null : null, newSize: change.newBlob ? sizes.get(change.newBlob) ?? null : null,
      ...(!regular(change.oldMode) || !regular(change.newMode) ? { unavailableReason: 'file_type' as const } : {}) }
      return { ...file, binary: false, additions: 0, deletions: 0, fileVersion: digest(diffFileVersionMaterial(input.repoId, revision, file)) }
    })
    if (Buffer.byteLength(JSON.stringify(files)) > MANIFEST_BYTES) return result([], [], 'too_large')
    const wanted = [...new Set(files.filter(file => regular(file.oldMode) && regular(file.newMode)
      && [file.oldSize, file.newSize].every(size => size === null || size! <= WORKSPACE_DIFF_MAX_BLOB_BYTES))
      .flatMap(file => [file.oldBlob, file.newBlob].filter((sha): sha is string => sha !== null)))]
    if (wanted.reduce((total, sha) => total + sizes.get(sha)!, 0) > CHECKPOINT_REVIEW_MAX_PROOF_BYTES) return result([], [], 'too_large')
    const blobs: CheckpointReviewEvidence['blobs'] = []
    if (wanted.length) {
      exceeded = true
      const content = await git(['cat-file', '--batch'], wanted.join('\n') + '\n', CHECKPOINT_REVIEW_MAX_PROOF_BYTES + wanted.length * 128)
      exceeded = false
      let offset = 0
      for (const sha of wanted) {
        signal.throwIfAborted()
        const end = content.indexOf(10, offset), size = sizes.get(sha)!
        if (end === -1 || content.subarray(offset, end).toString('ascii') !== `${sha} blob ${size}`
          || end + 1 + size >= content.length || content[end + 1 + size] !== 10) return result([], [], 'missing_evidence')
        const bytes = content.subarray(end + 1, end + 1 + size)
        blobs.push({ sha, base64: bytes.toString('base64') }); offset = end + 2 + size
      }
      if (offset !== content.length) return result([], [], 'missing_evidence')
    }
    signal.throwIfAborted()
    return result(files, blobs, null)
  } catch {
    // A review sidecar never blocks recovery. Return no partial source or raw
    // Git errors (which may include a path); the recovery patch is independent.
    return result([], [], exceeded ? 'too_large' : 'unsupported')
  }
}
