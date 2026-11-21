import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const workflowResult = z.object({
  version: z.literal(1), deliveryId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/u), installationId: id, repositoryId: id,
  repository: z.string().max(200).regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u), workflowId: id, workflowRunId: id,
  attempt: id, headSha: z.string().regex(/^[a-f0-9]{40}$/u),
  branch: z.string().max(255).regex(/^mikka\/[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/u),
  conclusion: z.enum(['success', 'failure']),
}).strict()
export type WorkflowResult = z.infer<typeof workflowResult>

export function verifyWorkflowResult(body: string, headers: Headers, secret: string, now = Date.now()): boolean {
  const timestamp = headers.get('x-mikka-ci-time'), signature = headers.get('x-mikka-ci-signature')
  if (!timestamp || !/^\d{10}$/u.test(timestamp) || Math.abs(Number(timestamp) - Math.floor(now / 1000)) > 300 ||
      !signature || !/^[a-f0-9]{64}$/u.test(signature)) return false
  const expected = createHmac('sha256', secret).update('mikka-ci-workflow-v1\n' + timestamp + '\n' + body).digest()
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}
