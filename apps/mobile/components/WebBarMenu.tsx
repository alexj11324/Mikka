import { useId, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { BarMenu } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { CloseButton, Group } from '@/components/ui'
import { colors, lift } from '@/lib/theme'

/** The Web fallback exposes every native toolbar menu item, including its selection state. */
export function WebBarMenu({ item }: { item: BarMenu }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const triggerId = `bar-menu-trigger-${id}`
  const panelId = `bar-menu-panel-${id}`
  const returnFocus = useRef<HTMLElement | null>(null)
  // SettingsPage also imports NavBar. Resolve the existing visual row after module
  // initialization, when this Web-only menu renders, instead of adding a static cycle.
  const Row = (require('@/components/settings') as typeof import('@/components/settings')).Row
  const close = () => {
    setOpen(false)
    requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus() })
  }
  const show = () => {
    returnFocus.current = document.getElementById(triggerId)
    setOpen(true)
  }
  const focusMenu = () => {
    requestAnimationFrame(() => {
      document.getElementById(panelId)?.querySelector<HTMLElement>('[role="button"], [role="radio"]')?.focus()
    })
  }
  return <>
    <Pressable nativeID={triggerId} accessibilityRole="button" accessibilityLabel={item.label}
      accessibilityState={{ expanded: open }} aria-expanded={open} onPress={show}
      style={({ pressed }) => [styles.trigger, pressed && { backgroundColor: colors.pressed }]}>
      {item.web}
    </Pressable>
    <Modal visible={open} transparent animationType="none" onRequestClose={close} onShow={focusMenu} accessibilityLabel={item.label}>
      <View style={styles.overlay}>
        <Pressable accessible={false} focusable={false} aria-hidden importantForAccessibility="no-hide-descendants" onPress={close} style={styles.backdrop} />
        <View nativeID={panelId} style={styles.panel}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{item.label}</Text>
            <CloseButton onPress={close} />
          </View>
          <ScrollView style={styles.items} keyboardShouldPersistTaps="handled">
            <Group>
              {item.items.map(entry => <Pressable key={entry.label}
                accessibilityRole={entry.on === undefined ? 'button' : 'radio'} accessibilityLabel={entry.label}
                accessibilityState={entry.on === undefined ? undefined : { checked: entry.on }} aria-checked={entry.on}
                onPress={() => { if (entry.on === undefined) setOpen(false); else close(); entry.onPress() }}
                style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}>
                <Row label={entry.label} trailing={entry.on ? <Check size={18} color={colors.ink} /> : null} />
              </Pressable>)}
            </Group>
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>
}

const styles = StyleSheet.create({
  trigger: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, ...lift },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  panel: { width: '100%', maxWidth: 360, maxHeight: '80%', borderRadius: 20, backgroundColor: colors.grouped, paddingHorizontal: 16, paddingTop: 12, ...lift },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  title: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600' },
  items: { flexGrow: 0, flexShrink: 1 },
  option: { minHeight: 44 },
})
