import { z } from 'zod'
import { CodedError } from '@mikka/protocol/coded-error'
import type { DecisionOption, DecisionSourceLocator } from './contracts'

export const MAP_NODE_LIMIT = 2000
export const MAP_BRANCH_LIMIT = 2000
export const MAP_EDGE_LIMIT = 20000
export const MAP_SOURCE_LIMIT = 10000
export const MAP_PAGE_LIMIT = 100
export const MAP_SOURCE_BYTES = 64 * 1024
export const MAP_METADATA_BYTES = 1024 * 1024
export const mapQueryFieldsSchema = z.object({
  workspaceId: z.uuid(), limit: z.coerce.number().int().min(1).max(MAP_PAGE_LIMIT).default(50),
  laneLimit: z.coerce.number().int().min(2).max(3).default(3), cursor: z.string().max(8192).optional(),
  snapshot: z.string().max(8192).optional(), branchId: z.string().min(1).max(256).optional(),
  q: z.string().trim().max(200).default(''), filter: z.enum(['all', 'mainline', 'abandoned', 'with_artifacts']).default('all'),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
}).strict()
export const mapQuerySchema = mapQueryFieldsSchema.refine(value => !value.from || !value.to || value.from <= value.to, { path: ['to'], message: 'Invalid time range' })
export type MapQuery = z.infer<typeof mapQuerySchema>
export type NodeStatus = 'planned' | 'active' | 'waiting' | 'completed' | 'failed' | 'abandoned' | 'unknown'
export type SourceRef = { sourceRef: string; role: string; optionId: string | null; relation: 'host_verified' | 'declared' | 'inferred'; availability: 'available' | 'unavailable'; locator: DecisionSourceLocator | null }
export type DecisionFact = {
  id: string; issueId: string | null; runId: string | null; factoryTaskId: string | null;
  kind: string; title: string; summary: string; reason: string; options: DecisionOption[];
  selectedOptionId: string | null; contextOptionRef: { decisionId: string; optionId: string } | null;
  predecessorDecisionIds: string[]; provenance: 'recorded' | 'inferred'; captureMode: 'live' | 'human_marked' | 'reconstructed';
  occurredAt: string; recordedAt: string; supersedesId: string | null; recordStatus: string; sources: SourceRef[];
  decidedBy: unknown; recordedBy: unknown;
}
export type MapNode = {
  id: string; type: 'project' | 'task' | 'run' | 'candidate' | 'decision' | 'branch_end';
  title: string; result: string | null; status: NodeStatus; occurredAt: string; order: number; branchId: string;
  lane: number | null; detailAvailable: boolean; badges: { artifacts: number; pullRequests: number; checks: number };
  decision: null | Pick<DecisionFact, 'id' | 'provenance' | 'captureMode' | 'selectedOptionId' | 'options' | 'reason'> & { sourceRefs: string[] };
}
export type MapEdge = { id: string; from: string; to: string; kind: 'continues' | 'fork' | 'merge' | 'depends_on'; evidence: 'declared' | 'host_verified' | 'inferred' }
export type MapBranch = {
  id: string; parentBranchId: string | null; forkNodeId: string | null;
  optionRef: { decisionId: string; optionId: string } | null; status: 'active' | 'completed' | 'abandoned' | 'not_taken' | 'unknown';
  stoppedAtNodeId: string | null; reason: string | null; sourceRefs: string[];
}
export type MapFold = { id: string; parentBranchId: string; anchor: { nodeId: string; order: number; lane: number };
  branchIds: string[]; orderStart: number; orderEnd: number; nodeCount: number; expand: { branchId: string } }
export type MapGraph = {
  nodes: MapNode[]; edges: MapEdge[]; branches: MapBranch[]; mainlineBranchIds: string[];
  /** Internal projection metadata; handlers never serialize these full maps. */
  laneStates: { order: number; occupied: { branchId: string; lane: number }[] }[];
  searchText: Record<string, string>;
  folds: MapFold[]; coverage: { decisions: 'recorded' | 'partial' | 'none'; issues: string[] };
  focus: null | { branchId: string; breadcrumbs: { branchId: string; forkNodeId: string }[] };
}
export type RunFact = { id: string; issueId: string; status: string; outcome: string | null; createdAt: string; finishedAt: string | null;
  retryOf: string | null; continuesRunId: string | null; threadReplacedBy?: string | null; harness: string | null; modelId: string | null; owned: boolean }
export type CandidateFact = { id: string; taskId: string; issueId: string; runId: string; kind: string; sha: string | null; createdAt: string; accepted: boolean }
export type CheckFact = { id: string; taskId: string; issueId: string; candidateId: string | null; runId: string | null;
  stage: string; status: string; reason: string | null; createdAt: string; finishedAt: string | null }
export type ArtifactFact = { id: string; versionId: string; version: number; issueId: string; runId: string | null; title: string; kind: string; createdAt: string }
export type PublicationFact = { runId: string; issueId: string; repositoryKey: string; number: number; url: string; commitSha: string | null }
export type MapFacts = {
  project: { id: string; title: string; createdAt: string; revision: number };
  issues: { id: string; title: string; status: string; createdAt: string; blockedByIds?: string[] }[];
  factoryVersions?: { id: string; revision: number; status: string; stage: string; candidateId: string | null }[];
  runs: RunFact[]; candidates: CandidateFact[]; checks: CheckFact[]; artifacts: ArtifactFact[];
  publications: PublicationFact[]; decisions: DecisionFact[];
}
const statuses = {
  map_invalid_request: 400, map_not_found: 404, map_snapshot_changed: 409, map_snapshot_expired: 410,
  map_too_large: 413, map_source_too_large: 413, map_scope_conflict: 409, map_unavailable: 503, map_auth_required: 401,
} as const
export type MapErrorCode = keyof typeof statuses
export class MapReadError extends CodedError<MapErrorCode, 'invalid_query' | 'invalid_token' | 'source_changed' | 'database' | 'signing_key' | 'limit'> {
  readonly status: number
  constructor(code: MapErrorCode, options: ConstructorParameters<typeof CodedError<MapErrorCode, 'invalid_query' | 'invalid_token' | 'source_changed' | 'database' | 'signing_key' | 'limit'>>[1] = {}) {
    super(code, options); this.status = statuses[code]
  }
}
