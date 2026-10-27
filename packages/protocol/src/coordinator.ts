import { z } from "zod"

export const coordinatorRuntimeSchema = z.discriminatedUnion("harness", [
  z.object({ harness: z.literal("ai_sdk") }).strict(),
  z.object({ harness: z.enum(["claude_code", "codex"]), deviceId: z.uuid(), model: z.string().trim().min(1).max(120).optional() }).strict(),
])
export type CoordinatorRuntime = z.infer<typeof coordinatorRuntimeSchema>
export const coordinatorToolSpecSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  description: z.string().max(20_000),
  inputSchema: z.record(z.string(), z.unknown()),
})
export const nativeCoordinatorJobSchema = z.object({
  id: z.uuid(), harness: z.enum(["claude_code", "codex"]),
  model: z.string().optional(), instructions: z.string().min(1).max(200_000),
  context: z.string().min(1).max(500_000),
  tools: z.array(coordinatorToolSpecSchema).max(100),
  expiresAt: z.iso.datetime(),
})
export type NativeCoordinatorJob = z.infer<typeof nativeCoordinatorJobSchema>
export const nativeCoordinatorClaimSchema = z.object({ job: nativeCoordinatorJobSchema.nullable() })
export const nativeCoordinatorCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), callId: z.string().min(1).max(200), name: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("complete"), text: z.string().min(1).max(200_000).refine(value => value.trim().length > 0) }).strict(),
  z.object({ type: z.literal("failed") }).strict(),
])
export type NativeCoordinatorCommand = z.infer<typeof nativeCoordinatorCommandSchema>
export const nativeCoordinatorToolResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("done"), output: z.unknown() }),
])
export type NativeCoordinatorToolResult = z.infer<typeof nativeCoordinatorToolResultSchema>
