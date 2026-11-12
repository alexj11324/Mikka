import type { ComposioAccounts, Settings } from './types'

export type PluginProvider = 'composio' | 'github' | 'linear' | 'telegram'
export interface PluginConnections {
  toolkits: string[]
  /** Service availability is separate from account ownership (Linear R-40). */
  paused?: string[]
  failed: { source: PluginProvider; reason: string }[]
}

/** Older servers return their original Settings DTO for the query. Their native
 * response only knows Linear. Other first-party statuses remain unknown. */
export function legacyPluginConnections(settings: Pick<Settings, 'apps'>, accounts: ComposioAccounts | null, linear: { enabled: boolean } | null): PluginConnections {
  const ids = new Set(accounts?.accounts.map(row => row.toolkit) ?? [])
  if (linear?.enabled && settings.apps.some(app => app.app === 'linear' && app.connected)) ids.add('linear')
  const unknown: PluginProvider[] = accounts ? ['github', 'telegram'] : ['composio', 'github', 'telegram']
  if (!linear) unknown.push('linear')
  return { toolkits: [...ids], paused: linear?.enabled === false ? ['linear'] : [], failed: unknown.map(source => ({ source, reason: 'statusUnavailable' })) }
}
