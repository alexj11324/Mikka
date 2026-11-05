import { Modal, Pressable, StyleSheet, View } from 'react-native'
import { Row } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { colors, lift } from '@/lib/theme'
import { menuLabel, type ChatMenuAction } from '../model/chat-menu'

/** The web and Android stand-in for the system context menu: the same actions, in a sheet. */
export function HomeMenuSheet({ name, actions, onAction, onClose }: {
  name: string
  actions: readonly ChatMenuAction[]
  onAction: (action: ChatMenuAction) => void
  onClose: () => void
}) {
  const main = actions.filter(action => action !== 'copy-id')
  const more = actions.filter(action => action === 'copy-id')
  const row = (action: ChatMenuAction) => (
    <Row key={action} label={menuLabel(action)} trailing={null} onPress={() => { onClose(); onAction(action) }} />
  )
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} accessibilityLabel={name}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="关闭" onPress={onClose} style={styles.backdrop} />
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>{name}</Text>
          <Group>{main.map(row)}</Group>
          {more.length ? <Group>{more.map(row)}</Group> : null}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', padding: 16 },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  panel: { borderRadius: 20, backgroundColor: colors.grouped, paddingHorizontal: 16, paddingTop: 16, borderCurve: 'continuous', ...lift },
  title: { fontSize: 17, fontWeight: '600', marginBottom: 12 },
})
