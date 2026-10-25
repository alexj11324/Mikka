import 'server-only'
import { Composio } from '@composio/core'
import { executeComposioAction, type ComposioActionName, type ComposioActionResult } from '@/lib/composio-actions'
import { beginQuota, quotaFailure, quotaToolError, tenantQuotas } from '@/lib/quota/runtime'

export const COMPOSIO_TOOLKITS = ['gmail', 'googlecalendar', 'notion', 'slack'] as const
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number]

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY
  return apiKey ? new Composio({ apiKey }) : null
}

export async function runComposioAction(userId: string, action: ComposioActionName, input: unknown, operationKey: string = crypto.randomUUID()): Promise<ComposioActionResult> {
  try {
    const quota = await beginQuota({ ownerId: userId, resource: 'composio.action', key: operationKey, binding: { action, input } })
    const result = await executeComposioAction(userId, action, input, getComposio(), async error => {
      const failure = quotaFailure(error)
      await tenantQuotas.finish(userId, quota.id, failure.outcome, undefined, failure.retryAfter)
    })
    const unsent = 'error' in result && ['integrationActionNotAllowed','invalidIntegrationInput','composioNotConfigured','integrationNotConnected','integrationMultipleAccounts','integrationActionVersionUnavailable'].includes(result.error)
    await tenantQuotas.finish(userId, quota.id, unsent ? 'refunded' : 'settled')
    return result
  } catch (error) {
    const failure = quotaToolError(error)
    return { error: failure.error }
  }
}

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return (COMPOSIO_TOOLKITS as readonly string[]).includes(value)
}
