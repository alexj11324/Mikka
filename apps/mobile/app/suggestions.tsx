import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Search } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { MenuIcon, SourceIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { Header, RoundButton } from '@/components/ui'
import { suggestions } from '@/lib/mock'
import { colors } from '@/lib/theme'

/** 建议: today's normal items in one list, each led by its app's icon and a verb (R-21, R-45). The briefing is not here. */
export default function SuggestionsScreen() {
  const drawer = useDrawer()
  const insets = useSafeAreaInsets()
  return (
    <View style={styles.screen}>
      <Header
        left={<RoundButton label="菜单" onPress={drawer.open}><MenuIcon /></RoundButton>}
        title="建议"
        right={<RoundButton label="搜索"><Search size={20} color={colors.ink} strokeWidth={2} /></RoundButton>}
      />
      <FlatList
        data={suggestions}
        keyExtractor={item => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        renderItem={({ item, index }) => (
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.row, index === 0 && styles.first, index === suggestions.length - 1 && styles.last, pressed && { backgroundColor: colors.pressed }]}>
            <SourceIcon source={item.source} size={20} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.meta} numberOfLines={1}>{item.meta}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.grouped },
  list: { paddingHorizontal: 16, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 10 },
  first: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 14 },
  last: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, paddingBottom: 14 },
  title: { fontSize: 16 },
  meta: { fontSize: 12, color: colors.secondary, marginTop: 2 },
})
