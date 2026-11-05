import { useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChatRowView, rowKey, useChatRows } from '@/components/ChatList'
import { accountItem } from '@/components/AccountButton'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { botPath } from '@/lib/pins'
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
  const { rows, loading, error, reload } = useChatRows(needle)
  return (
    <View style={styles.screen}>
      <NavBar title="搜索" left={accountItem(router)} search={{ placeholder: '搜索 Bot 和群聊', onChange: setQuery }} />
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        {...underBar}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={<ReadNotice error={error} hasData={rows.length > 0} label="对话列表" onRetry={reload} />}
        ListEmptyComponent={loading ? <View style={styles.loading}><Spinner /></View> : !error && needle ? <Text style={styles.note}>没有找到「{query.trim()}」</Text> : undefined}
        ListFooterComponent={loading && rows.length > 0 ? <View style={styles.loading}><Spinner /></View> : undefined}
        renderItem={({ item }) => <ChatRowView row={item} onPress={() => router.push(item.kind === 'bot' ? botPath(item.bot) : `/groups/${item.group.id}`)} />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  loading: { alignItems: 'center', paddingVertical: 24 },
  note: { textAlign: 'center', color: colors.secondary, marginTop: 32, fontSize: 15 },
})
