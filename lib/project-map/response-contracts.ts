import { z } from 'zod'
import { decisionOptionSchema, decisionSourceLocatorSchema, optionRefSchema } from './contracts'
import { MAP_BRANCH_LIMIT, MAP_NODE_LIMIT, MAP_PAGE_LIMIT, MAP_SOURCE_LIMIT } from './read-contracts'

/** Shared v1 wire contracts for the backend and the separately implemented map UI. */
const id = z.string().min(1).max(256), time = z.iso.datetime(), order = z.number().int().nonnegative()
const lane = z.number().int().min(0).max(2).nullable(), refs = z.array(id).max(MAP_SOURCE_LIMIT)
const edgeKind = z.enum(['continues', 'fork', 'merge', 'depends_on'])
const sourceEvidence = z.enum(['host_verified', 'declared', 'inferred'])
const provenance = z.enum(['recorded', 'inferred']), captureMode = z.enum(['live', 'human_marked', 'reconstructed'])
const options = z.array(decisionOptionSchema).max(20)
// Canonical app-root links have no trailing slash before their query.
const appHref = z.string().regex(/^\/mikka(?:\/|\?|$)/)
const live = z.object({ ownerId: z.string().min(1).max(200), workspaceId: z.uuid(),
  revisions: z.record(z.string().regex(/^project_map:[a-f0-9-]{36}$/), z.number().int().positive()).refine(value => Object.keys(value).length <= 1) }).strict()
const snapshot = z.object({ id: z.string().max(8192), expiresAt: time, layoutVersion: z.literal(1) }).strict()
const page = z.object({ hasMore: z.boolean(), nextCursor: z.string().max(8192).nullable() }).strict()
const common = { schemaVersion: z.literal(1), live }
const versioned = { ...common, snapshotId: z.string().max(8192) }

export const mapNodeSchema = z.object({
  id, type: z.enum(['project', 'task', 'run', 'candidate', 'decision', 'branch_end']),
  title: z.string(), result: z.string().nullable(),
  status: z.enum(['planned', 'active', 'waiting', 'completed', 'failed', 'abandoned', 'unknown']),
  occurredAt: time, order, branchId: id, lane, detailAvailable: z.boolean(),
  badges: z.object({ artifacts: order, pullRequests: order, checks: order }).strict(),
  decision: z.object({ id: z.uuid(), provenance, captureMode, selectedOptionId: id.nullable(),
    options, reason: z.string(), sourceRefs: refs }).strict().nullable(),
}).strict()
export const mapEdgeSchema = z.object({ id: z.string().max(1024), from: id, to: id, kind: edgeKind, evidence: sourceEvidence }).strict()
export const mapBranchSchema = z.object({ id, parentBranchId: id.nullable(), forkNodeId: id.nullable(),
  optionRef: optionRefSchema.nullable(), status: z.enum(['active', 'completed', 'abandoned', 'not_taken', 'unknown']),
  stoppedAtNodeId: id.nullable(), reason: z.string().nullable(), sourceRefs: refs }).strict()
export const mapFoldSchema = z.object({ id, parentBranchId: id,
  anchor: z.object({ nodeId: id, order, lane: z.number().int().min(0).max(2) }).strict(),
  branchIds: z.array(id).max(MAP_BRANCH_LIMIT), orderStart: order, orderEnd: order, nodeCount: order,
  expand: z.object({ branchId: id }).strict() }).strict()
const branches = z.array(mapBranchSchema).max(MAP_BRANCH_LIMIT)
const folds = z.array(mapFoldSchema).max(MAP_BRANCH_LIMIT)
const edges = z.array(mapEdgeSchema).max(20000)
const branchIds = z.array(id).max(MAP_BRANCH_LIMIT)
const occupied = z.array(z.object({ branchId: id, lane: z.number().int().min(0).max(2) }).strict()).max(3)

export const mapPageResponseSchema = z.object({
  ...common, snapshot, coverage: z.object({ decisions: z.enum(['recorded', 'partial', 'none']), issues: z.array(z.string()).max(MAP_NODE_LIMIT) }).strict(),
  nodes: z.array(mapNodeSchema).max(MAP_PAGE_LIMIT), edges, branches, mainlineBranchIds: branchIds,
  boundaryNodes: z.array(z.object({ id, order, lane }).strict()).max(MAP_NODE_LIMIT),
  laneState: z.object({ before: occupied, after: occupied }).strict(), folds,
  focus: z.object({ branchId: id, breadcrumbs: z.array(z.object({ branchId: id, forkNodeId: id }).strict()).max(MAP_BRANCH_LIMIT) }).strict().nullable(),
  page: page.extend({ matchedCount: order }).strict(),
}).strict()

const task = z.object({ id: z.uuid(), title: z.string(), status: z.string(), href: appHref }).strict()
export const mapDecisionDetailSchema = z.object({
  id: z.uuid(), kind: z.enum(['choose', 'redirect', 'abandon', 'merge', 'confirm']),
  title: z.string(), summary: z.string(), reason: z.string(), options, selectedOptionId: id.nullable(),
  contextOptionRef: optionRefSchema.nullable(), predecessorDecisionIds: z.array(z.uuid()).max(20),
  provenance, captureMode, occurredAt: time, recordedAt: time, supersedesId: z.uuid().nullable(),
  recordStatus: z.enum(['active', 'retracted']), sourceRefs: refs,
}).strict()
const artifact = z.object({ id: z.uuid(), versionId: z.uuid(), title: z.string(), mediaType: z.string(),
  href: z.string().regex(/^\/mikka\/api\/artifacts\/[a-f0-9-]{36}\/versions\/[1-9][0-9]*\/download$/) }).strict()
const check = z.object({ attemptId: z.uuid(), candidateId: z.uuid(), runId: z.uuid().nullable(),
  stage: z.enum(['review', 'verify']), status: z.string(), reason: z.string().nullable(), checkedAt: time.nullable(), sourceRefs: refs }).strict()
const summary = z.object({ text: z.string(), provenance, sourceRefs: refs }).strict()
const thread = z.object({ rootRunId: z.uuid(), harness: z.string().nullable(), status: z.string(), href: appHref }).strict()
const run = z.object({ id: z.uuid(), rootRunId: z.uuid(), href: appHref }).strict()
const publication = z.object({ repositoryKey: z.string(), number: z.number().int().positive(),
  url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable() }).strict()
const section = <K extends string, T extends z.ZodType>(kind: K, item: T, max = MAP_NODE_LIMIT) =>
  z.object({ kind: z.literal(kind), items: z.array(item).max(max) }).strict()
export const mapNodeResponseSchema = z.object({
  ...versioned, node: mapNodeSchema,
  sections: z.tuple([section('tasks', task, 100), section('decisions', mapDecisionDetailSchema), section('artifacts', artifact),
    section('checks', check), section('conversation_summary', summary), section('threads', thread)]),
  references: z.object({ runs: z.array(run).max(MAP_NODE_LIMIT), pullRequests: z.array(publication).max(MAP_NODE_LIMIT), sources: refs }).strict(),
}).strict()
export const mapPathResponseSchema = z.object({
  ...versioned, targetNodeId: id, nodes: z.array(z.object({ id, order, branchId: id, lane }).strict()).max(MAP_NODE_LIMIT),
  edges, primaryPathNodeIds: z.array(id).max(MAP_NODE_LIMIT), selectedOptions: z.array(optionRefSchema).max(MAP_NODE_LIMIT),
  expand: z.array(z.object({ branchId: id, forkNodeId: id }).strict()).max(MAP_BRANCH_LIMIT),
}).strict()
export const mapOverviewResponseSchema = z.object({
  ...versioned, totalVisibleNodes: order, matchedCount: order,
  range: z.object({ fromOrder: order, toOrder: order, fromTime: time, toTime: time }).strict().nullable(),
  bins: z.array(z.object({ fromOrder: order, toOrder: order, nodeCount: order, branchIds,
    hasAbandoned: z.boolean(), hasArtifact: z.boolean() }).strict()).max(100),
  branches, mainlineBranchIds: branchIds,
  branchLinks: z.array(z.object({ fromBranchId: id, toBranchId: id, atOrder: order,
    kind: z.enum(['continues', 'fork', 'merge']) }).strict()).max(20000),
  laneSegments: z.array(z.object({ branchId: id, fromOrder: order, toOrder: order, lane, foldId: id.nullable() }).strict()).max(MAP_BRANCH_LIMIT),
  folds,
}).strict()
const recordItem = z.object({ text: z.string() }).strict()
const chunkItem = z.object({ id: z.uuid(), seq: order, text: z.string() }).strict()
export const mapSourceResponseSchema = z.discriminatedUnion('sourceKind', [
  z.object({ ...common, sourceRef: id, sourceKind: z.literal('record'), availability: z.literal('available'),
    locator: decisionSourceLocatorSchema, items: z.array(recordItem).length(1), page }).strict(),
  z.object({ ...common, sourceRef: id, sourceKind: z.literal('run_chunks'), availability: z.literal('available'),
    locator: decisionSourceLocatorSchema, items: z.array(chunkItem).max(100), page }).strict(),
  z.object({ ...common, sourceRef: id, sourceKind: z.literal('unavailable'), availability: z.literal('unavailable'),
    locator: z.null(), items: z.array(z.never()).length(0),
    page: z.object({ nextCursor: z.null(), hasMore: z.literal(false) }).strict() }).strict(),
])
export type MapPageResponse = z.infer<typeof mapPageResponseSchema>
export type MapNodeResponse = z.infer<typeof mapNodeResponseSchema>
export type MapPathResponse = z.infer<typeof mapPathResponseSchema>
export type MapOverviewResponse = z.infer<typeof mapOverviewResponseSchema>
export type MapSourceResponse = z.infer<typeof mapSourceResponseSchema>
