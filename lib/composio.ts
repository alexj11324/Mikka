import 'server-only'
import { Composio } from '@composio/core'
import { type ComposioActionName, type ComposioActionResult } from '@/lib/composio-actions'
import { tenantQuotas } from '@/lib/quota/runtime'
import { budgetedComposioAction } from '@/lib/quota/composio'

export const COMPOSIO_TOOLKITS = ['gmail', 'googlecalendar', 'notion', 'slack'] as const
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number]

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY
  return apiKey ? new Composio({ apiKey }) : null
}

export async function runComposioAction(userId: string, action: ComposioActionName, input: unknown, operationKey: string = crypto.randomUUID()): Promise<ComposioActionResult> {
  return budgetedComposioAction(tenantQuotas, userId, action, input, getComposio, operationKey)
}

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return (COMPOSIO_TOOLKITS as readonly string[]).includes(value)
}
