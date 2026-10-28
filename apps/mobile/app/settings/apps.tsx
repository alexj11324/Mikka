import { Pressable } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { SourceIcon } from '@/components/icons'
import { Row, SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { API_URL } from '@/lib/config'
import { useSettings } from '@/lib/settings'
import { colors } from '@/lib/theme'

const NAME: Record<string, string> = { gmail: 'Gmail', googlecalendar: 'Google 日历', notion: 'Notion', slack: 'Slack', linear: 'Linear', github: 'GitHub' }

/** 已连接的 App (Claude Connectors, ChatGPT 插件). Connecting happens in the web's Settings, opened in the browser. */
export default function AppsScreen() {
  const { data, reload } = useSettings()
  const connected = (data?.apps ?? []).filter(app => app.connected)
  const available = (data?.apps ?? []).filter(app => !app.connected)
  const connect = async () => {
    await WebBrowser.openBrowserAsync(`${API_URL}/settings`)
    await reload()
  }
  return (
    <SettingsPage title="已连接的 App">
      {connected.length ? (
        <Group>{connected.map(app => <Row key={app.app} icon={<SourceIcon source={app.app} size={24} />} label={NAME[app.app] ?? app.app} detail={app.account ?? undefined} />)}</Group>
      ) : null}
      {available.length ? (
        <Group label="未连接">
          {available.map(app => (
            <Row key={app.app} icon={<SourceIcon source={app.app} size={24} />} label={NAME[app.app] ?? app.app}
              trailing={<Pressable accessibilityRole="button" onPress={() => void connect()}><Text style={{ color: colors.accent, fontSize: 16 }}>连接</Text></Pressable>} />
          ))}
        </Group>
      ) : null}
    </SettingsPage>
  )
}
