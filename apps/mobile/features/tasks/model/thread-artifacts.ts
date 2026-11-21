/**
 * A thread's Artifact segment (Alex, 2026-11-15, as ChatGPT's 聊天 | 工作 and Warp's run page): what
 * `GET /api/mobile/threads/:id/artifacts` returns (lib/mobile-thread-artifacts.ts on the server).
 */
export const THREAD_ARTIFACT_GROUPS = ['plans', 'pullRequests', 'reports', 'captures'] as const
export type ThreadArtifactGroup = (typeof THREAD_ARTIFACT_GROUPS)[number]

export type ThreadArtifact =
  | { group: 'plans' | 'reports'; id: string; artifactId: string; title: string; version: number; kind: 'markdown' | 'html' }
  | { group: 'pullRequests'; id: string; url: string; state: 'open' | 'draft' | 'merged' | 'closed' | null; title: string | null }
  | { group: 'captures'; id: string; captureId: string; kind: 'image' | 'video'; title: string | null; webPath: string | null }

export type ThreadArtifacts = { groups: Record<ThreadArtifactGroup, ThreadArtifact[]>; count: number }

/** 线程 | Artifact: the conversation, or what it produced. */
export type ThreadSegment = 'thread' | 'artifacts'

export const threadArtifactsPath = (runId: string | null | undefined) => runId ? `/api/mobile/threads/${runId}/artifacts` : null

/** The groups to draw, in order, each with its count; an empty group is left out. */
export function shownGroups(data: ThreadArtifacts | null | undefined) {
  return THREAD_ARTIFACT_GROUPS.flatMap(group => data?.groups[group]?.length ? [{ group, items: data.groups[group] }] : [])
}

/** The toggle is shown only for a thread that produced something; otherwise the bar keeps its title. */
export const hasThreadArtifacts = (data: ThreadArtifacts | null | undefined) => (data?.count ?? 0) > 0
