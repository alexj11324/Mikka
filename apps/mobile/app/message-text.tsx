import { StyleSheet, TextInput, View } from 'react-native'
import { NavBar } from '@/components/NavBar'
import { heldMessage } from '@/lib/message-actions'
import { colors, font } from '@/lib/theme'

/**
 * 选择文本: the message's words, where the system's own selection handles pick
 * any part to copy or look up. The field takes selection, not edits, and no
 * keyboard comes up.
 */
export default function MessageText() {
  const text = heldMessage()?.text ?? ''
  return (
    <View style={styles.screen}>
      <NavBar title="选择文本" />
      <TextInput value={text} onChangeText={() => {}} multiline showSoftInputOnFocus={false} autoFocus
        scrollEnabled contextMenuHidden={false} style={styles.text} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  text: { flex: 1, paddingHorizontal: 20, paddingTop: 16, fontSize: 17, lineHeight: 26, color: colors.text, fontFamily: font, textAlignVertical: 'top' },
})
