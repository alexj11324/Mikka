import { useRef, useState, type ComponentRef } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { groupTag, groupTitle, modelMenuLabel, modelMenuReadLabel, modelSourceLabel, optionName, type ModelMenuControls } from '@/lib/model-menu'
import { colors } from '@/lib/theme'
import { mobileMessages as copy } from '@/lib/messages'

/** Expo Web exposes the same saved choices and source groups as the native menu. */
export function ModelMenu({ model, running = false, label }: { model: ModelMenuControls; running?: boolean; label?: string }) {
  const { menu, loading, retryRead, busy, choosing, choose, refresh, refreshing, refreshFailed } = model
  const [open, setOpen] = useState(false)
  const trigger = useRef<ComponentRef<typeof View>>(null)
  const closeButton = useRef<ComponentRef<typeof View>>(null)
  const close = () => { setOpen(false); setTimeout(() => trigger.current?.focus(), 0) }
  if (!menu) return <Pressable accessibilityRole="button" accessibilityState={{ disabled: loading, busy: loading }} aria-disabled={loading} aria-busy={loading} disabled={loading}
    onPress={() => { void retryRead().catch(() => undefined) }} style={styles.chip}><Text style={styles.label}>{modelMenuReadLabel(loading)}</Text></Pressable>
  const { current, groups } = menu
  return <>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={copy.Coordinator.modelPicker.label.replace('{name}', modelSourceLabel(current))} accessibilityState={{ expanded: open, busy }} aria-expanded={open} aria-busy={busy} aria-disabled={false} onPress={() => setOpen(true)} style={styles.chip}>
      <Text style={[styles.label, label ? { color: colors.accent } : null]}>{label ?? `${modelMenuLabel(current, running)} ▾`}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="none" onRequestClose={close} onShow={() => closeButton.current?.focus()}>
      <View style={styles.overlay}>
        <View accessibilityViewIsModal style={styles.menu}>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>{copy.Coordinator.modelPicker.changeModel}</Text>
            <Pressable ref={closeButton} accessibilityRole="button" accessibilityLabel={copy.Common.close} onPress={close} style={styles.close}><Text style={styles.action}>{copy.Common.close}</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.options}>
            {groups.map((group, index) => <View key={`${group.kind}-${index}`} style={styles.group}>
              <Text accessibilityRole="header" style={styles.source}>{groupTitle(group)}</Text>
              {group.options.map(option => <Pressable key={option.id} accessibilityRole="radio" accessibilityLabel={`${optionName(option)}，${groupTitle(group)}${groupTag(group) ? `，${groupTag(group)}` : ''}`}
                accessibilityState={{ checked: current.id === option.id, disabled: busy, busy: choosing === option.id }} aria-checked={current.id === option.id} aria-disabled={busy} aria-busy={choosing === option.id} disabled={busy}
                onPress={() => { close(); void choose(option.id) }} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.pressed }]}>
                <View style={styles.optionBody}><Text style={styles.optionName}>{optionName(option)}</Text>{groupTag(group) ? <Text style={styles.source}>{groupTag(group)}</Text> : null}</View>
                {current.id === option.id ? <Text style={styles.action}>✓</Text> : null}
              </Pressable>)}
            </View>)}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy: refreshing }} aria-disabled={busy} aria-busy={refreshing} disabled={busy} onPress={() => { void refresh() }} style={styles.option}>
              <Text style={styles.action}>{refreshing ? copy.Common.loading : refreshFailed ? copy.Coordinator.modelPicker.refreshFailed : copy.Coordinator.modelPicker.refresh}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>
}
const styles = StyleSheet.create({
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6, flexShrink: 1 },
  label: { fontSize: 13, color: colors.ink },
  overlay: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: colors.scrim },
  menu: { width: '100%', maxWidth: 440, maxHeight: '80%', alignSelf: 'center', borderRadius: 20, backgroundColor: colors.page, overflow: 'hidden' },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '600', color: colors.ink },
  close: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  options: { padding: 12, gap: 8 },
  group: { gap: 4 },
  source: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  option: { minHeight: 44, paddingHorizontal: 8, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 10 },
  optionBody: { flex: 1, gap: 3 },
  optionName: { fontSize: 15, color: colors.ink },
  action: { fontSize: 14, color: colors.text },
})
