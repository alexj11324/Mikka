import { ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { BotAvatar } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Row } from '@/components/settings'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { useHome } from '@/lib/home'
import { colors } from '@/lib/theme'

/**
 * A bot's page, opened from its name at the top of its chat (as in Grok and
 * WhatsApp): the avatar and name, then what the desktop app shows beside the
 * chat. 线程 is here now; 电脑, PR, 定时任务 and 资料库 follow with their
 * mobile endpoints.
 */
export default function BotInfo() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const bot = useHome().data?.bots.find(item => item.id === id)
  const name = id === 'coordinator' ? 'Coordinator' : bot?.name ?? ''
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <NavBar title="" />
      <ScrollView {...underBar} contentContainerStyle={styles.body}>
        <View style={styles.hero}>
          <BotAvatar color={bot?.color} shape={bot?.shape} size={96} />
          <Text style={styles.name}>{name}</Text>
        </View>
        <Group>
          <Row icon={<Symbol name="checklist" size={19} />} label="线程" onPress={() => router.push(`/bots/${id}/threads`)} />
        </Group>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16 },
  hero: { alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 28 },
  name: { fontSize: 26, fontWeight: '700' },
})
