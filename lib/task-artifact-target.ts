/**
 * Where a task's artifact opens (the Factory activity read, lib/factory/activity.ts): a stored document (a plan,
 * an acceptance report, any Artifact) in the Artifact window by its id; a pull request on GitHub; a screenshot or a
 * recording at its media address. Anything else has nowhere to open.
 */
export type TaskArtifactRef = { artifactId?: string | null; kind?: string | null; url?: string | null }
export type TaskArtifactTarget = { kind: 'artifact'; id: string } | { kind: 'link'; url: string } | null

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function taskArtifactTarget(item: TaskArtifactRef | null | undefined): TaskArtifactTarget {
  if (!item) return null
  if (item.artifactId && UUID.test(item.artifactId)) return { kind: 'artifact', id: item.artifactId }
  const url = item.url?.trim()
  if (!url) return null
  // GitHub pull requests open there; media and other in-app addresses stay on this origin.
  if (/^https:\/\//i.test(url) || url.startsWith('/')) return { kind: 'link', url }
  return null
}
