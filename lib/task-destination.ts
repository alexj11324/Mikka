import { z } from 'zod'

export const taskDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud') }).strict(),
  z.object({ kind: z.literal('device'), deviceId: z.uuid() }).strict(),
])
export type TaskDestination = z.infer<typeof taskDestinationSchema>

/** Model-only context. The person's displayed message keeps its normal copy. */
export function taskDestinationPrompt(destination: TaskDestination): string {
  return destination.kind === 'cloud'
    ? 'The person selected Mikka Cloud (their own cloud computer) in the task dialog. Keep that destination; do not dispatch to a local device.'
    : `The person selected device ${destination.deviceId} in the task dialog. Use a local execution identity on exactly this device; do not substitute another device or Mikka Cloud.`
}
