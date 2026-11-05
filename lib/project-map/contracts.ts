import { z } from 'zod'
import type { IssueReader } from '@/lib/issue-visibility'

export const optionRefSchema = z.object({ decisionId: z.uuid(), optionId: z.string().min(1).max(80) }).strict()
export const decisionOptionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/),
  title: z.string().trim().min(1).max(200),
  disposition: z.enum(['selected', 'rejected', 'abandoned', 'retained']),
  reason: z.string().trim().min(1).max(4000).nullable().default(null),
  derivedFrom: optionRefSchema.nullable().default(null),
  stoppedAtSourceRef: z.uuid().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if ((value.disposition === 'rejected' || value.disposition === 'abandoned') && !value.reason)
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A stopped or rejected option requires a reason' })
})

/** References only records already held by Mikka. A locator never authorizes access. */
export const decisionSourceLocatorSchema = z.object({
  type: z.enum(['issue', 'run', 'run_chunk', 'run_message', 'bot_message', 'group_message', 'question', 'answer', 'factory_task', 'attempt', 'candidate', 'factory_event', 'acceptance', 'artifact_version', 'pull_request', 'commit']),
  id: z.string().min(1).max(200),
  runId: z.uuid().optional(),
  issueId: z.uuid().optional(),
  seq: z.number().int().nonnegative().optional(),
  botId: z.uuid().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
  conversationId: z.uuid().optional(),
  sessionId: z.string().min(1).max(200).optional(),
  taskId: z.uuid().optional(),
  versionId: z.uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
  answerId: z.string().min(1).max(200).optional(),
  repositoryKey: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  prNumber: z.number().int().positive().optional(),
}).strict()
export const decisionSourceSchema = z.object({
  role: z.enum(['evidence', 'branch_work', 'stopped_at', 'merges_from']).default('evidence'),
  optionId: z.string().min(1).max(80).optional(),
  source: decisionSourceLocatorSchema,
}).strict()

export const recordDecisionSchema = z.object({
  projectId: z.uuid().optional(),
  workspaceId: z.uuid().optional(),
  issueId: z.uuid().optional(),
  factoryTaskId: z.uuid().optional(),
  runId: z.uuid().optional(),
  kind: z.enum(['choose', 'redirect', 'abandon', 'merge', 'confirm']),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(4000),
  options: z.array(decisionOptionSchema).max(20).default([]),
  selectedOptionId: z.string().min(1).max(80).nullable().default(null),
  contextOptionRef: optionRefSchema.nullable().default(null),
  predecessorDecisionIds: z.array(z.uuid()).max(20).default([]),
  sources: z.array(decisionSourceSchema).max(50).default([]),
  decidedBy: z.object({ kind: z.enum(['human', 'bot', 'agent', 'unknown']), id: z.string().min(1).max(200).optional() }).strict().optional(),
  supersedesId: z.uuid().optional(),
  recordStatus: z.enum(['active', 'retracted']).default('active'),
  provenance: z.enum(['recorded', 'inferred']).default('recorded'),
  idempotencyKey: z.string().min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const ids = value.options.map(option => option.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option ids must be unique' })
  if (new Set(value.predecessorDecisionIds).size !== value.predecessorDecisionIds.length)
    ctx.addIssue({ code: 'custom', path: ['predecessorDecisionIds'], message: 'Predecessors must be unique' })
  const selected = value.options.filter(option => option.disposition === 'selected')
  if (value.kind === 'choose' || value.kind === 'redirect') {
    if (!value.selectedOptionId || selected.length !== 1 || selected[0]?.id !== value.selectedOptionId)
      ctx.addIssue({ code: 'custom', path: ['selectedOptionId'], message: 'Choose and redirect require exactly one selected option' })
  } else if (value.selectedOptionId && !ids.includes(value.selectedOptionId))
    ctx.addIssue({ code: 'custom', path: ['selectedOptionId'], message: 'Unknown selected option' })
  if (value.kind === 'abandon' && !value.contextOptionRef)
    ctx.addIssue({ code: 'custom', path: ['contextOptionRef'], message: 'Abandon must identify the existing route' })
  if (value.recordStatus === 'retracted' && !value.supersedesId)
    ctx.addIssue({ code: 'custom', path: ['supersedesId'], message: 'Retraction must reference the original decision' })
  if (value.provenance === 'inferred' && !value.sources.length)
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'An inference requires original Mikka evidence' })
})
export type RecordDecisionInput = z.input<typeof recordDecisionSchema>
export type ParsedDecisionInput = z.output<typeof recordDecisionSchema>
export type DecisionOption = z.output<typeof decisionOptionSchema>
export type DecisionSourceLocator = z.output<typeof decisionSourceLocatorSchema>
export type DecisionSourceInput = z.output<typeof decisionSourceSchema>
export type DecisionActor =
  | { kind: 'human'; user: IssueReader; workspaceId: string; originalMessageAt?: Date }
  | { kind: 'bot'; userId: string; workspaceId: string; botId: string | null; sessionId?: string | null; messagePosition?: number; modelId?: string | null; harness?: string | null }
  | { kind: 'run'; userId: string; runId: string; workspaceId?: string; leaseId?: string | null; token?: string }

export class ProjectMapError extends Error {
  constructor(public code: string, public status: number = 400) { super(code); this.name = 'ProjectMapError' }
}
