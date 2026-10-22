import 'server-only'
import { Composio } from '@composio/core'

export const COMPOSIO_TOOLKITS = ['notion', 'slack'] as const
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number]

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY
  return apiKey ? new Composio({ apiKey }) : null
}

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return (COMPOSIO_TOOLKITS as readonly string[]).includes(value)
}
