import { z } from 'zod'
import { RESOURCE_ACTIONS, RESOURCE_KINDS } from './contract'

export const resourceReferenceInput = z.object({ kind:z.enum(RESOURCE_KINDS),id:z.guid().transform(value=>value.toLowerCase()),workspaceId:z.uuid() }).strict()
const grant = z.object({ subjectId:z.string().min(1).max(256),capabilities:z.array(z.enum(RESOURCE_ACTIONS)).min(1).max(RESOURCE_ACTIONS.length),expiresAt:z.iso.datetime().nullable().optional() }).strict()
export const resourceAccessChangeSchema = z.object({ expectedRevision:z.number().int().positive(),visibility:z.enum(['shared','private']),
  grants:z.array(grant).max(200),confirmExpansion:z.boolean().default(false) }).strict()

export const threadExecutionGrantInput = z.object({
  actorId:z.string().min(1).max(256),credentialId:z.uuid(),model:z.string().trim().min(1).max(200),harness:z.enum(['claude_code','codex']),
  totalComputeSeconds:z.number().int().min(60).max(86_400),maxTurnSeconds:z.number().int().min(30).max(3600),expiresAt:z.iso.datetime(),
  confirmExternalResourceUse:z.literal(true),
}).strict().refine(value=>value.maxTurnSeconds<=value.totalComputeSeconds)
