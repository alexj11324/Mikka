import { z } from 'zod'

export const taskDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), provider: z.literal('cloudflare').optional() }).strict(),
  // The person may also name the computer's Agent (a computer registers one
  // per installed CLI). The host applies it; the model's tool input cannot.
  z.object({ kind: z.literal('device'), deviceId: z.uuid(), agentId: z.uuid().optional() }).strict(),
])
export type TaskDestination = z.infer<typeof taskDestinationSchema>

/** Model-only context. The person's displayed message keeps its normal copy. */
export function taskDestinationPrompt(destination: TaskDestination): string {
  if(destination.kind==='cloud'&&destination.provider==='cloudflare') return 'The person selected a Mikka-sponsored Cloudflare Linux coding machine. Keep this task, repository and payer fixed.'
  return destination.kind === 'cloud'
    ? 'The person selected Mikka Cloud (their own cloud computer) in the task dialog. Keep that destination; do not dispatch to a local device.'
    : `The person selected device ${destination.deviceId}${destination.agentId ? ` and its Agent ${destination.agentId}` : ''} in the task dialog. Use a local execution identity on exactly this device; do not substitute another device or Mikka Cloud.`
}
