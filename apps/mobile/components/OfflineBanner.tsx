import { StyleSheet, View } from 'react-native'
import { useNetworkState } from 'expo-network'
import { WifiOff } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { colors, lift } from '@/lib/theme'

/** The phone has no connection (iMessage, Slack): what is sent now will not arrive. Unknown counts as online. */
export function useOffline(): boolean {
  const network = useNetworkState()
  return network.isConnected === false || network.isInternetReachable === false
}

/** A pill under the header while the phone is offline; nothing otherwise. */
export function OfflineBanner({ top }: { top: number }) {
  const offline = useOffline()
  if (!offline) return null
  return (
    <View pointerEvents="none" style={[styles.wrap, { top }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={styles.pill}>
        <Symbol name="wifi.slash" size={13} color={colors.secondary} web={<WifiOff size={14} color={colors.secondary} strokeWidth={2.2} />} />
        <Text style={styles.text}>没有网络</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 20 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: '#fff', ...lift },
  text: { fontSize: 13, color: colors.secondary },
})
