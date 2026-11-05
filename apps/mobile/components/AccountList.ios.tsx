import { Button, Form, HStack, Host, RNHostView, Section, Text, VStack } from '@expo/ui/swift-ui'
import { badge, foregroundStyle, tint } from '@expo/ui/swift-ui/modifiers'
import type { Href } from 'expo-router'
import { MyAvatar } from '@/components/AccountButton'
import { accountEntries } from '@/lib/account'
import { useHome } from '@/lib/home'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { colors } from '@/lib/theme'

/** The account sheet's list: the system's grouped Form (SwiftUI), its rows the system's buttons. */
export function AccountList({ go }: { go: (href: Href) => void }) {
  const { data } = useHome()
  const updateReady = useUpdateReady()
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section>
          <Button onPress={() => go('/settings/profile')} modifiers={[tint(colors.ink)]}>
            <HStack spacing={12}>
              <RNHostView matchContents><MyAvatar size={44} /></RNHostView>
              <VStack alignment="leading" spacing={2}>
                <Text>{data?.user.name || data?.user.email || ''}</Text>
                {data?.user.name && data.user.email ? <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{data.user.email}</Text> : null}
              </VStack>
            </HStack>
          </Button>
          {data ? <Button label={`工作区 · ${data.workspace.name}`} systemImage="briefcase" onPress={() => go('/settings/workspace')} modifiers={[tint(colors.ink)]} /> : null}
        </Section>
        {accountEntries(data?.suggestions).map((section, index) => (
          <Section key={index}>
            {section.map(entry => <Button key={entry.label} label={entry.label} systemImage={entry.icon} onPress={() => go(entry.href)}
              modifiers={[tint(colors.ink), ...(entry.badge ? [badge(String(entry.badge))] : [])]} />)}
          </Section>
        ))}
        {updateReady ? <Section><Button label="重启以更新" systemImage="arrow.down.circle" onPress={restartToUpdate} /></Section> : null}
      </Form>
    </Host>
  )
}
