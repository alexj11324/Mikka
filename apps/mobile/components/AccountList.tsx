import type { Href } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { CircleArrowDown, Inbox, ListChecks, Puzzle, Settings, BriefcaseBusiness } from 'lucide-react-native'
import { MyAvatar } from '@/components/AccountButton'
import { Row } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { accountEntries, type AccountEntry } from '@/lib/account'
import { useHome } from '@/lib/home'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { colors } from '@/lib/theme'

const ICONS: Record<AccountEntry['icon'], typeof Inbox> = { tray: Inbox, checklist: ListChecks, 'puzzlepiece.extension': Puzzle, gearshape: Settings }

/** The web build's account list, drawn with the settings rows; iOS uses the system Form (AccountList.ios.tsx). */
export function AccountList({ go }: { go: (href: Href) => void }) {
  const { data } = useHome()
  const updateReady = useUpdateReady()
  const icon = (Icon: typeof Inbox, color: string = colors.ink) => <Icon size={20} color={color} strokeWidth={1.8} />
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Group>
        <Row icon={<MyAvatar size={36} />} label={data?.user.name || data?.user.email || ''} detail={data?.user.name ? data.user.email : undefined} onPress={() => go('/settings/profile')} />
        {data ? <Row icon={icon(BriefcaseBusiness)} label="工作区" value={data.workspace.name} onPress={() => go('/settings/workspace')} /> : null}
      </Group>
      {accountEntries(data?.suggestions).map((section, index) => (
        <Group key={index}>
          {section.map(entry => <Row key={entry.label} icon={icon(ICONS[entry.icon])} label={entry.label} onPress={() => go(entry.href)}
            trailing={entry.badge ? <View style={{ minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>{entry.badge}</Text></View> : undefined} />)}
        </Group>
      ))}
      {updateReady ? <Group><Row icon={icon(CircleArrowDown, colors.accent)} label="重启以更新" onPress={restartToUpdate} /></Group> : null}
    </ScrollView>
  )
}
