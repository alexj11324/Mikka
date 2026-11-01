import { useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChatRowView, rowKey, useChatRows } from '@/components/ChatList'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { chatPath } from '@/lib/navigate'
import { colors } from '@/lib/theme'

/**
 * 搜索, the tab bar's search (iOS 26's search tab, as in Alex's Grok
 * screenshot): the field sits at the bottom, and the bots and group chats
 * whose names match show above it.
 */
export default function SearchScreen() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const { rows } = useChatRows(needle)
  return (
    <View style={styles.screen}>
      <NavBar title="搜索" search={{ placeholder: '搜索', onChange: setQuery }} />
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        {...underBar}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={needle ? <Text style={styles.note}>没有找到「{query.trim()}」</Text> : undefined}
        renderItem={({ item }) => <ChatRowView row={item} onPress={() => router.push(item.kind === 'bot' ? chatPath(item.bot.id) : `/groups/${item.group.id}`)} />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  note: { textAlign: 'center', color: colors.secondary, marginTop: 32, fontSize: 15 },
})
