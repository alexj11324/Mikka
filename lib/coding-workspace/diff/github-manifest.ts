import 'server-only'
import { z } from 'zod'
import { CodingWorkspaceError, visibleWorkspacePath, workspacePath } from '@mikka/protocol/coding-workspace'
import { diffFileMetadata, WorkspaceReviewError, type DiffFileMetadata } from '@mikka/protocol/coding-workspace-review'
import { diffFileVersion } from './patch'

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const treeEntry = z.object({ path: workspacePath.refine(Boolean), sha,
  mode: z.enum(['040000', '100644', '100755', '120000', '160000']), type: z.enum(['tree', 'blob', 'commit']),
  size: z.number().int().nonnegative().optional() })
const treeResult = z.object({ sha, truncated: z.literal(false), tree: z.array(treeEntry).max(100_000) })
const unavailable = () => new WorkspaceReviewError('workspace_snapshot_unavailable')
const regular = (mode: string | undefined) => mode === undefined || mode === '100644' || mode === '100755'
const visible = (path: string) => { if (!visibleWorkspacePath(path)) throw new CodingWorkspaceError('workspace_path_unavailable') }

export type GitHubTreeEntry = { sha: string; mode: string; size: number | null }
export type GitHubNativeFile = {
  path: string; previousPath: string | null; status: 'added' | 'removed' | 'modified' | 'renamed';
  sha: string; additions: number; deletions: number; patchSha256: string | null; page: number;
}

/** A truncated tree cannot establish a complete comparison. Directories are
 * validated but excluded from the file manifest; gitlinks retain their OIDs. */
export function parseGitHubTree(value: unknown, expectedSha: string): Map<string, GitHubTreeEntry> {
  const parsed = treeResult.safeParse(value)
  if (!parsed.success || parsed.data.sha !== expectedSha) throw unavailable()
  const nodes = new Map<string, z.infer<typeof treeEntry>>()
  for (const entry of parsed.data.tree) {
    if (nodes.has(entry.path) || entry.type !== (entry.mode === '040000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob')
      || (entry.type === 'blob' && entry.size === undefined)) throw unavailable()
    nodes.set(entry.path, entry)
  }
  const files = new Map<string, GitHubTreeEntry>()
  for (const entry of nodes.values()) {
    const components = entry.path.split('/')
    for (let length = 1; length < components.length; length++) {
      const parent = nodes.get(components.slice(0, length).join('/'))
      if (parent && parent.type !== 'tree') throw unavailable()
    }
    if (entry.type !== 'tree') files.set(entry.path, { sha: entry.sha, mode: entry.mode, size: entry.size ?? null })
  }
  return files
}

/** Native PR paths/statuses must cover exactly the immutable tree difference.
 * A compare endpoint's merge-base is only a candidate until this check passes.
 * Explicit commits instead compare the two complete trees directly. */
export function buildGitHubManifest(input: {
  repoId: string; repositoryId: string; baseSha: string; headSha: string;
  before: Map<string, GitHubTreeEntry>; after: Map<string, GitHubTreeEntry>; nativeFiles?: GitHubNativeFile[];
}): DiffFileMetadata[] {
  const { before, after, nativeFiles } = input
  const changed = new Set([...before.keys(), ...after.keys()].filter(path => {
    const old = before.get(path), next = after.get(path)
    return old?.sha !== next?.sha || old?.mode !== next?.mode
  }))
  if (changed.size > 20_000 || (nativeFiles && nativeFiles.length > 3000)) throw new CodingWorkspaceError('workspace_limit_exceeded')
  for (const path of changed) visible(path)
  const metadata = (path: string, previousPath: string | null, status: DiffFileMetadata['status'],
    old: GitHubTreeEntry | undefined, next: GitHubTreeEntry | undefined, native?: GitHubNativeFile): DiffFileMetadata => {
    visible(path); if (previousPath) visible(previousPath)
    const base = { path, previousPath, status, oldBlob: old?.sha ?? null, newBlob: next?.sha ?? null,
      oldMode: old?.mode ?? null, newMode: next?.mode ?? null, oldSize: old?.size ?? null, newSize: next?.size ?? null,
      additions: native?.additions ?? 0, deletions: native?.deletions ?? 0, binary: false,
      ...(!regular(old?.mode) || !regular(next?.mode) ? { unavailableReason: 'file_type' as const } : {}),
      github: { repositoryId: input.repositoryId, patchSha256: native?.patchSha256 ?? null, page: native?.page ?? null } }
    const parsed = diffFileMetadata.safeParse({ ...base, fileVersion: diffFileVersion(input.repoId, input, base) })
    if (!parsed.success) throw unavailable()
    return parsed.data
  }
  const files: DiffFileMetadata[] = []
  if (nativeFiles) {
    const paths = new Set<string>(), oldPaths = new Set<string>(), newPaths = new Set<string>()
    for (const native of nativeFiles) {
      if (paths.has(native.path) || !changed.has(native.path)) throw unavailable()
      paths.add(native.path)
      const previous = native.status === 'renamed' ? native.previousPath : null
      if (native.status === 'renamed' ? !previous || previous === native.path : native.previousPath !== null) throw unavailable()
      const oldPath = previous ?? native.path, old = before.get(oldPath), next = after.get(native.path)
      if (native.status === 'added' ? old !== undefined || next === undefined
        : native.status === 'removed' ? old === undefined || next !== undefined
          : old === undefined || next === undefined) throw unavailable()
      if (native.sha !== (next?.sha ?? old?.sha)) throw unavailable()
      if (old) {
        if (oldPaths.has(oldPath)) throw unavailable()
        oldPaths.add(oldPath)
      }
      if (next) newPaths.add(native.path)
      if (previous) { visible(previous); if (!changed.has(previous)) throw unavailable() }
      files.push(metadata(native.path, previous, native.status === 'removed' ? 'deleted' : native.status, old, next, native))
    }
    // A rename consumes one old side and one new side. Merely covering both
    // path names would silently lose a replaced target or a recreated source.
    // Every changed tree entry on each side must be represented exactly once.
    if ([...changed].some(path => before.has(path) !== oldPaths.has(path) || after.has(path) !== newPaths.has(path))) throw unavailable()
  } else {
    const removed = new Map<string, string[]>(), added = new Map<string, string[]>()
    const key = (entry: GitHubTreeEntry) => `${entry.mode}:${entry.sha}`
    for (const path of changed) {
      const old = before.get(path), next = after.get(path)
      if (old && next) files.push(metadata(path, null, 'modified', old, next))
      else {
        const groups = old ? removed : added, entry = old ?? next!
        const group = groups.get(key(entry)) ?? []; group.push(path); groups.set(key(entry), group)
      }
    }
    const renamed = new Set<string>()
    for (const [identity, oldPaths] of removed) {
      const newPaths = added.get(identity)
      if (oldPaths.length === 1 && newPaths?.length === 1) {
        const oldPath = oldPaths[0]!, newPath = newPaths[0]!
        files.push(metadata(newPath, oldPath, 'renamed', before.get(oldPath), after.get(newPath)))
        renamed.add(oldPath); renamed.add(newPath)
      }
    }
    for (const paths of removed.values()) for (const path of paths)
      if (!renamed.has(path)) files.push(metadata(path, null, 'deleted', before.get(path), undefined))
    for (const paths of added.values()) for (const path of paths)
      if (!renamed.has(path)) files.push(metadata(path, null, 'added', undefined, after.get(path)))
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  if (Buffer.byteLength(JSON.stringify(files)) > 1536 * 1024) throw new CodingWorkspaceError('workspace_limit_exceeded')
  return files
}
