import 'server-only'
import { Composio } from '@composio/core'
import { executeComposioAction, type ComposioActionName, type ComposioActionResult } from '@/lib/composio-actions'

export const COMPOSIO_TOOLKITS = ['notion', 'slack'] as const
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number]

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY
  return apiKey ? new Composio({ apiKey }) : null
}

export function runComposioAction(userId: string, action: ComposioActionName, input: unknown): Promise<ComposioActionResult> {
  return executeComposioAction(userId, action, input, getComposio())
}

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return (COMPOSIO_TOOLKITS as readonly string[]).includes(value)
}
