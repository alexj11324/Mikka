import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChatRowContent } from '@/components/ChatList'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { chatHref } from '../components/chat-href'
import { useHomeChats } from '../model/use-home-chats'

/** 隐藏的聊天: the chats hidden from the home list, each with 取消隐藏, which puts it back. A tap opens it as on home. */
export function HiddenChatsScreen() {
  const router = useRouter()
  const actions = useHomeChats()
  const hidden = actions.chats.filter(chat => chat.hidden)
  return (
    <View style={styles.screen}>
      <NavBar title="隐藏的聊天" large />
      <FlatList
        data={hidden}
        keyExtractor={chat => chat.key}
        {...underBar}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={actions.loading ? undefined : <Text style={styles.none}>没有隐藏的聊天</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={() => router.push(chatHref(item))} style={({ pressed }) => [styles.open, pressed && { backgroundColor: colors.pressed }]}>
              <ChatRowContent row={item.row} />
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void actions.setHidden(item, false)} hitSlop={8} style={({ pressed }) => [styles.show, pressed && { opacity: 0.6 }]}>
              <Text style={styles.showText}>取消隐藏</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  row: { flexDirection: 'row', alignItems: 'center' },
  open: { flex: 1, minWidth: 0 },
  show: { height: 32, paddingHorizontal: 12, marginRight: 16, borderRadius: 16, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  showText: { fontSize: 14, fontWeight: '600', color: colors.accent },
  none: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
})
