import { useState } from 'react'
import { StyleSheet } from 'react-native'
import { ChoiceRow, SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { api, saveWorkspace } from '@/lib/api'
import { useHome } from '@/lib/home'
import { useSettings } from '@/lib/settings'
import type { Settings } from '@/lib/types'
import { switchWorkspace } from '@/lib/workspace-switch'
import { colors } from '@/lib/theme'

/**
 * 工作区 picker (Comma iOS, ChatGPT 工作空间). The choice travels as the web's
 * mikka-workspace cookie. The picked row spins until the server answers; a
 * switch that does not take stays on the old workspace and says why.
 */
export default function WorkspaceScreen() {
  const { data, reload } = useSettings()
  const home = useHome()
  const [switching, setSwitching] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const pick = async (target: { id: string; name: string }) => {
    if (switching || target.id === data?.workspace.id) return
    setSwitching(target.id)
    setProblem(null)
    setProblem(await switchWorkspace(target, data?.workspace.id ?? null, {
      save: saveWorkspace,
      current: async () => (await api<Settings>('/api/mobile/settings')).workspace.id,
    }))
    await Promise.all([reload(), home.reload()])
    setSwitching(null)
  }
  return (
    <SettingsPage title="工作区">
      <Group>{(data?.workspaces ?? []).map(w => <ChoiceRow key={w.id} label={w.name} selected={w.id === data?.workspace.id} busy={switching === w.id} disabled={Boolean(switching)} onPress={() => void pick(w)} />)}</Group>
      {problem ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.problem}>{problem}</Text> : null}
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  problem: { fontSize: 13, color: colors.danger, marginTop: -10, marginLeft: 16 },
})
