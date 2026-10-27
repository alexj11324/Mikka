import { z } from 'zod'

export const SCREEN_WIDTH = 1280
export const SCREEN_HEIGHT = 800
export const machineStateSchema = z.enum(['sleeping', 'waking', 'running', 'error'])
export const controlStateSchema = z.enum(['agent', 'user', 'idle'])
export const computerToolSchema = z.enum(['click', 'type', 'key', 'scroll', 'screenshot'])
export const screenRectSchema = z.object({ x: z.number(), y: z.number(), w: z.number().nonnegative(), h: z.number().nonnegative() })
export const computerActionSchema = z.object({ tool: computerToolSchema, x: z.number().optional(), y: z.number().optional(), text: z.string().optional(), rect: screenRectSchema.optional() })
export const lastActionSchema = computerActionSchema.omit({ text: true }).extend({ at: z.iso.datetime() })
export const approvalViewSchema = z.object({
  id: z.string(), digest: z.string(), runId: z.string(), botId: z.string(),
  action: computerActionSchema, summary: z.string(), expiresAt: z.iso.datetime(),
})
export const computerStateSchema = z.object({
  machine: machineStateSchema, control: controlStateSchema,
  controlledBy: z.object({ userId: z.string() }).optional(),
  lastAction: lastActionSchema.optional(), pendingApproval: approvalViewSchema.optional(),
})
export const viewerModeSchema = z.enum(['view', 'control'])
export const viewerRequestSchema = z.object({ mode: viewerModeSchema }).strict()
export const viewerGrantSchema = z.object({ url: z.url({ protocol: /^wss$/ }), expiresAt: z.iso.datetime() })
export const createBotSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict()
export const botViewSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(120) })
export const approvalDecisionSchema = z.object({ digest: z.string(), decision: z.enum(['approve', 'deny']), scope: z.enum(['once', 'run']) }).strict()
export const computerTaskStateSchema = z.enum(['working', 'approval', 'done', 'failed'])
export const computerTaskSchema = z.object({ botId: z.string(), runId: z.string(), task: z.string(), state: computerTaskStateSchema, approvalId: z.string().optional() })
export const subagentStateSchema = z.enum(['queued', 'running', 'needs_you', 'done', 'failed', 'stopped'])
export const subagentEventSchema = z.object({
  type: z.literal('data-subagent'),
  data: z.object({ botId: z.uuid(), subagentId: z.uuid(), task: z.string().trim().min(1).max(200),
    state: subagentStateSchema, needs: z.string().trim().min(1).max(1000).optional() }).strict(),
}).strict()
export const computerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('computer.machine'), state: machineStateSchema }),
  z.object({ type: z.literal('computer.control'), botId: z.string(), control: controlStateSchema, controlledBy: z.object({ userId: z.string() }).optional() }),
  z.object({ type: z.literal('computer.action'), botId: z.string(), lastAction: lastActionSchema }),
  z.object({ type: z.literal('computer.approval'), botId: z.string(), approval: approvalViewSchema.nullable() }),
])

export type MachineState = z.infer<typeof machineStateSchema>
export type ControlState = z.infer<typeof controlStateSchema>
export type ComputerTool = z.infer<typeof computerToolSchema>
export type ScreenRect = z.infer<typeof screenRectSchema>
export type LastAction = z.infer<typeof lastActionSchema>
export type ApprovalView = z.infer<typeof approvalViewSchema>
export type ComputerState = z.infer<typeof computerStateSchema>
export type ViewerMode = z.infer<typeof viewerModeSchema>
export type ViewerGrant = z.infer<typeof viewerGrantSchema>
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>
export type ComputerTaskState = z.infer<typeof computerTaskStateSchema>
export type ComputerTask = z.infer<typeof computerTaskSchema>
export type SubagentState = z.infer<typeof subagentStateSchema>
export type SubagentEvent = z.infer<typeof subagentEventSchema>
export type ComputerEvent = z.infer<typeof computerEventSchema>

// Daemon review snapshots contain no screenshot or model credentials. Display
// is assigned by trusted infrastructure and included in the exact digest.
const reviewDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const localComputerCall = z.discriminatedUnion('name', [
  z.object({ name: z.literal('get_desktop_state'), arguments: z.object({}).strict() }).strict(),
  z.object({ name: z.literal('click'), arguments: z.object({ x: z.number().int().min(0).max(100000), y: z.number().int().min(0).max(100000) }).strict() }).strict(),
  z.object({ name: z.literal('type_text'), arguments: z.object({ text: z.string().min(1).max(8000) }).strict() }).strict(),
  z.object({ name: z.literal('press_key'), arguments: z.object({
    key: z.string().regex(/^(?:[\x20-\x7e]|enter|return|tab|escape|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))$/),
    modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'super'])).max(4).refine(items => new Set(items).size === items.length).optional(),
  }).strict() }).strict(),
  z.object({ name: z.literal('scroll'), arguments: z.object({ direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(50), x: z.number().int().min(0).max(100000), y: z.number().int().min(0).max(100000) }).strict() }).strict(),
])
export const localComputerRequest = z.object({
  id: z.uuid(), runId: z.uuid(), target: reviewDigestSchema,
  display: z.string().regex(/^:[1-9][0-9]{0,2}$/).optional(),
  call: localComputerCall, expiresAt: z.number().int().positive(), digest: reviewDigestSchema,
}).strict()
export const localComputerDecision = z.object({ id: z.uuid(), digest: reviewDigestSchema, approve: z.boolean() }).strict()
export const computerSyncBody = z.object({ requests: z.array(localComputerRequest).max(20) }).strict()
export const computerSyncResponse = z.object({ decisions: z.array(localComputerDecision).max(20) }).strict()
export type LocalComputerRequest = z.infer<typeof localComputerRequest>
export type LocalComputerDecision = z.infer<typeof localComputerDecision>
export const computerSyncPath = (deviceId: string) => `/v1/devices/${encodeURIComponent(deviceId)}/computer`
