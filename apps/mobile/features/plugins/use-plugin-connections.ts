import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useApi } from '@/lib/useApi'
import type { ComposioAccounts, Settings } from '@/lib/types'
import { legacyPluginConnections, type PluginConnections } from '@/lib/plugin-connections'

/** Both native routes use the same account-scoped reader, including the plugin
 * list reached from Suggestions outside SettingsProvider. */
export function usePluginConnections() {
  const [focused, setFocused] = useState(false)
  useFocusEffect(useCallback(() => {
    setFocused(true)
    return () => setFocused(false)
  }, []))
  const directory = useApi<PluginConnections | Settings>(focused ? '/api/mobile/settings?view=pluginConnections' : null)
  const legacy = directory.data && 'apps' in directory.data ? directory.data : null
  const accounts = useApi<ComposioAccounts>(focused && legacy ? '/api/integrations/composio' : null)
  const linear = useApi<{ enabled: boolean }>(focused && legacy ? '/api/integrations/linear/status' : null)
  const snapshot = useMemo(() => {
    if (directory.data && 'toolkits' in directory.data) return directory.data
    return legacy ? legacyPluginConnections(legacy, accounts.data, linear.data) : null
  }, [directory.data, legacy, accounts.data, linear.data])
  const providerNames = { composio: 'Composio', github: 'GitHub', linear: 'Linear', telegram: 'Telegram' }
  const failedProviders = snapshot?.failed.map(failure => providerNames[failure.source]) ?? []
  const noticeLabel = failedProviders.length ? `${failedProviders.join('、')} 连接状态` : '连接状态'
  const hasRetainedData = Boolean((directory.error || accounts.error) && snapshot)
  return { snapshot, noticeLabel, hasRetainedData, error: directory.error || accounts.error || Boolean(snapshot?.failed.length),
    reload: async () => { await Promise.all([directory.reload(), accounts.reload(), linear.reload()]) } }
}
