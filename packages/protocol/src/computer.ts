// Owner-reviewed local device operations. No model token or screenshot crosses this API.
import { z } from "zod"
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const localComputerCall = z.discriminatedUnion("name", [
  z.object({ name: z.literal("get_desktop_state"), arguments: z.object({}).strict() }).strict(),
  z.object({ name: z.literal("click"), arguments: z.object({ x: z.number().int().min(0).max(100000), y: z.number().int().min(0).max(100000) }).strict() }).strict(),
  z.object({ name: z.literal("type_text"), arguments: z.object({ text: z.string().min(1).max(8000) }).strict() }).strict(),
])
export const localComputerRequest = z.object({
  id: z.uuid(), runId: z.uuid(), target: digest, call: localComputerCall,
  expiresAt: z.number().int().positive(), digest,
}).strict()
export const localComputerDecision = z.object({ id: z.uuid(), digest, approve: z.boolean() }).strict()
export const computerSyncBody = z.object({ requests: z.array(localComputerRequest).max(20) }).strict()
export const computerSyncResponse = z.object({ decisions: z.array(localComputerDecision).max(20) }).strict()
export type LocalComputerRequest = z.infer<typeof localComputerRequest>
export type LocalComputerDecision = z.infer<typeof localComputerDecision>
export const computerSyncPath = (deviceId: string) => `/v1/devices/${encodeURIComponent(deviceId)}/computer`
