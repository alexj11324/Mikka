import { toolkitAccountStates, type ToolkitState } from '../../../lib/composio-account-state'
import type { ComposioAccounts, Settings } from './types'

export type PluginProvider = 'composio' | 'github' | 'linear' | 'telegram'
export interface PluginConnections {
  toolkits: string[]
  states?: Record<string, ToolkitState>
  /** Service availability is separate from account ownership (Linear R-40). */
  paused?: string[]
  failed: { source: PluginProvider; reason: string }[]
}

/** Older servers return their original Settings DTO for the query. Their native
 * response only knows Linear. Other first-party statuses remain unknown. */
export function legacyPluginConnections(settings: Pick<Settings, 'apps'>, accounts: ComposioAccounts | null, linear: { enabled: boolean } | null): PluginConnections {
  const states = toolkitAccountStates(accounts?.accounts ?? [])
  const ids = new Set(Object.keys(states))
  if (linear?.enabled && settings.apps.some(app => app.app === 'linear' && app.connected)) {
    ids.add('linear')
    states.linear = 'active'
  }
  const unknown: PluginProvider[] = accounts ? ['github', 'telegram'] : ['composio', 'github', 'telegram']
  if (!linear) unknown.push('linear')
  return { toolkits: [...ids], states, paused: linear?.enabled === false ? ['linear'] : [], failed: unknown.map(source => ({ source, reason: 'statusUnavailable' })) }
}
