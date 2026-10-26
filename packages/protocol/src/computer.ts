import { z } from 'zod'

export const SCREEN_WIDTH = 1280
export const SCREEN_HEIGHT = 800
export const machineStateSchema = z.enum(['sleeping', 'waking', 'running', 'error'])
export const controlStateSchema = z.enum(['agent', 'user', 'idle'])
export const computerToolSchema = z.enum(['click', 'type', 'key', 'scroll'])
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
export const approvalDecisionSchema = z.object({ digest: z.string(), decision: z.enum(['approve', 'deny']), scope: z.enum(['once', 'run']) }).strict()
export const computerTaskStateSchema = z.enum(['working', 'approval', 'done', 'failed'])
export const computerTaskSchema = z.object({ botId: z.string(), runId: z.string(), task: z.string(), state: computerTaskStateSchema, approvalId: z.string().optional() })
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
export type ComputerEvent = z.infer<typeof computerEventSchema>
