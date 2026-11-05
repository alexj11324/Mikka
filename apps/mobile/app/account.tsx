import { View } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import { X } from 'lucide-react-native'
import { AccountList } from '@/components/AccountList'
import { NavBar } from '@/components/NavBar'
import { colors } from '@/lib/theme'

/**
 * The account sheet (#1386 item 8, decision 2026-11-05-1300): opened from the avatar on a tab root, a system page
 * sheet as in App Store and Music. Swipe down closes it; a row closes it and opens its page over the tabs.
 */
export default function Account() {
  const router = useRouter()
  const go = (href: Href) => { router.back(); router.push(href) }
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <NavBar title="账户" right={{ icon: 'xmark', label: '完成', web: <X size={20} color={colors.ink} />, onPress: () => router.back() }} />
      <AccountList go={go} />
    </View>
  )
}
