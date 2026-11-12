import { isCloudEdition } from '@/lib/edition'
import { readGitHubAppConfig } from '@/lib/github/app-config'
import { readGitHubWebhookBody } from '@/lib/github/webhook-dispatch'
import { workflowResult, verifyWorkflowResult } from '@/lib/github/workflow-result'

export const runtime = 'nodejs'

/** Only the official edge consumer signs this bounded, domain-separated projection. */
export async function POST(request: Request): Promise<Response> {
  if (!isCloudEdition()) return new Response(null, { status: 404 })
  const secret = (await readGitHubAppConfig()).webhookSecret
  if (!secret) return new Response(null, { status: 503 })
  const body = await readGitHubWebhookBody(request, 2048)
  if (body === null) return new Response(null, { status: 413 })
  if (!verifyWorkflowResult(body, request.headers, secret)) return new Response(null, { status: 401 })
  let value: unknown
  try { value = JSON.parse(body) } catch { return new Response(null, { status: 400 }) }
  const result = workflowResult.safeParse(value)
  if (!result.success) return new Response(null, { status: 400 })
  await (await import('@/lib/github/workflow-result-store')).acceptWorkflowResult(result.data)
  return new Response(null, { status: 204 })
}
