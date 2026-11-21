import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { Spinner } from '@/components/icons'
import { colors, LIST_INSET } from '@/lib/theme'

/**
 * A list's empty state (R-41): one concrete line, an optional one-line detail, and at most one
 * action. A bare `<Text>` left-aligned in the list is the defect this replaces — it reads as a
 * stray label rather than the state of the screen, and looks nothing like the same state on web
 * (components/ui/empty.tsx), where the icon, title and detail are centred and spaced.
 */
export function EmptyState({ icon, title, detail, action }: { icon?: ReactNode; title: string; detail?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  )
}

/** A list that is still loading its first page: the spinner where the rows will be, not in the header. */
export function ListLoading() {
  return <View style={styles.loading}><Spinner /></View>
}

const styles = StyleSheet.create({
  loading: { paddingTop: 40, alignItems: 'center' },
  // Centred and clear of the header: an empty list is a state, not a first row.
  empty: { alignItems: 'center', gap: 6, paddingHorizontal: LIST_INSET, paddingTop: 56, paddingBottom: 24 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.chip, marginBottom: 4 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.text, textAlign: 'center' },
  detail: { fontSize: 13, lineHeight: 18, color: colors.secondary, textAlign: 'center' },
  action: { marginTop: 10 },
})
