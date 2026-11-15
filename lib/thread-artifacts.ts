import { githubPullRequestKey, type IssuePullRequest } from './issue-metadata'

/**
 * A thread's Artifact tab (Alex, 2026-11-15, as Warp's run page): everything its
 * work produced, in four groups. Pure, so what each group holds is testable
 * without a server; the readers stay the existing authorized ones.
 */
export const THREAD_ARTIFACT_GROUPS = ['plans', 'pullRequests', 'reports', 'captures'] as const
export type ThreadArtifactGroup = (typeof THREAD_ARTIFACT_GROUPS)[number]

type PullState = IssuePullRequest['state']
export type ThreadArtifactItem =
  | { group: 'plans' | 'reports'; id: string; artifactId: string; title: string; version: number | null }
  | { group: 'pullRequests'; id: string; url: string; state: PullState | null; title: string | null }
  | { group: 'captures'; id: string; kind: 'image' | 'video'; title: string | null; url: string; posterUrl: string | null; durationMs: number | null; contentType: string | null }

/** The Factory task's admitted submissions, as its activity read carries them (lib/factory/activity.ts). */
export type FactoryArtifactReceipt = { id: string; kind: string; runId: string; title?: string | null; artifactId?: string; version?: number
  url?: string; state?: string | null; posterUrl?: string | null; durationMs?: number | null; contentType?: string | null; captureId?: string }
/** A run's own Artifact (listRunArtifacts) or submitted document (the run evidence route). */
export type RunArtifactRef = { id: string; title: string; latestVersion?: number | null }
/** A screenshot or recording from the run evidence route. */
export type RunCaptureRef = { id: string; kind: string; title: string | null; url: string; durationMs?: number | null; contentType?: string | null }

export type ThreadArtifactInput = {
  factory: readonly FactoryArtifactReceipt[] | null
  /** Only these runs' receipts (a review or verify thread); null for the task's conversation, which shows the whole task. */
  runIds: readonly string[] | null
  /** The task's pull requests, for the task's conversation. */
  pullRequests?: readonly IssuePullRequest[]
  runArtifacts?: readonly RunArtifactRef[]
  captures?: readonly RunCaptureRef[]
}

const PULL_STATES: readonly string[] = ['open', 'draft', 'merged', 'closed']
const pullState = (state: string | null | undefined): PullState | null => state && PULL_STATES.includes(state) ? state as PullState : null
const GITHUB_PULL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/

export function threadArtifacts({ factory, runIds, pullRequests = [], runArtifacts = [], captures = [] }: ThreadArtifactInput): Record<ThreadArtifactGroup, ThreadArtifactItem[]> {
  const groups: Record<ThreadArtifactGroup, ThreadArtifactItem[]> = { plans: [], pullRequests: [], reports: [], captures: [] }
  const own = runIds ? new Set(runIds) : null
  const documents = new Set<string>(), pulls = new Set<string>(), media = new Set<string>()
  for (const receipt of factory ?? []) {
    if (own && !own.has(receipt.runId)) continue
    if ((receipt.kind === 'plan' || receipt.kind === 'acceptance' || receipt.kind === 'document') && receipt.artifactId) {
      documents.add(receipt.artifactId)
      groups[receipt.kind === 'plan' ? 'plans' : 'reports'].push({ group: receipt.kind === 'plan' ? 'plans' : 'reports', id: receipt.id,
        artifactId: receipt.artifactId, title: receipt.title ?? '', version: receipt.version ?? null })
    } else if ((receipt.kind === 'image' || receipt.kind === 'video') && receipt.url) {
      media.add(receipt.captureId ?? receipt.id)
      groups.captures.push({ group: 'captures', id: receipt.id, kind: receipt.kind, title: receipt.title ?? null, url: receipt.url,
        posterUrl: receipt.posterUrl ?? null, durationMs: receipt.durationMs ?? null, contentType: receipt.contentType ?? null })
    } else if (receipt.kind === 'pull_request' && receipt.url && GITHUB_PULL.test(receipt.url) && !pulls.has(githubPullRequestKey(receipt.url))) {
      pulls.add(githubPullRequestKey(receipt.url))
      groups.pullRequests.push({ group: 'pullRequests', id: receipt.id, url: receipt.url, state: pullState(receipt.state), title: receipt.title ?? null })
    }
  }
  // The task's own PR list keeps the newest state GitHub reported; a receipt already listed takes it.
  for (const pull of pullRequests) {
    const key = githubPullRequestKey(pull.url)
    const listed = groups.pullRequests.find(item => item.group === 'pullRequests' && githubPullRequestKey(item.url) === key)
    if (listed && listed.group === 'pullRequests') { listed.state = pull.state; listed.title = listed.title ?? pull.title ?? null; continue }
    if (!GITHUB_PULL.test(pull.url)) continue
    pulls.add(key)
    groups.pullRequests.push({ group: 'pullRequests', id: pull.url, url: pull.url, state: pull.state, title: pull.title ?? null })
  }
  for (const artifact of runArtifacts) {
    if (documents.has(artifact.id)) continue
    documents.add(artifact.id)
    groups.reports.push({ group: 'reports', id: artifact.id, artifactId: artifact.id, title: artifact.title, version: artifact.latestVersion ?? null })
  }
  for (const capture of captures) {
    if (media.has(capture.id) || (capture.kind !== 'image' && capture.kind !== 'video')) continue
    media.add(capture.id)
    groups.captures.push({ group: 'captures', id: capture.id, kind: capture.kind, title: capture.title, url: capture.url,
      posterUrl: null, durationMs: capture.durationMs ?? null, contentType: capture.contentType ?? null })
  }
  return groups
}

export const threadArtifactCount = (groups: Record<ThreadArtifactGroup, readonly ThreadArtifactItem[]>) =>
  THREAD_ARTIFACT_GROUPS.reduce((total, group) => total + groups[group].length, 0)
