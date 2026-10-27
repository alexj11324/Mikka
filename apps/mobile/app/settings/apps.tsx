import { Pressable } from 'react-native'
import { SourceIcon } from '@/components/icons'
import { Row, SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { availableApps, connectedApps } from '@/lib/mock'
import { colors } from '@/lib/theme'

/** 已连接的 App (Claude Connectors, ChatGPT 插件). */
export default function AppsScreen() {
  return (
    <SettingsPage title="已连接的 App">
      <Group>
        {connectedApps.map(app => <Row key={app.name} icon={<SourceIcon source={app.source} size={24} />} label={app.name} detail={app.account} onPress={() => {}} />)}
      </Group>
      <Group label="未连接">
        {availableApps.map(app => (
          <Row key={app.name} icon={<SourceIcon source={app.source} size={24} />} label={app.name}
            trailing={<Pressable accessibilityRole="button"><Text style={{ color: colors.accent, fontSize: 16 }}>连接</Text></Pressable>} />
        ))}
      </Group>
    </SettingsPage>
  )
}
