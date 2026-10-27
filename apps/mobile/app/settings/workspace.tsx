import { ChoiceRow, SettingsPage } from '@/components/settings'
import { Group } from '@/components/ui'
import { saveWorkspace } from '@/lib/api'
import { useHome } from '@/lib/home'
import { useSettings } from '@/lib/settings'

/** 工作区 picker (Comma iOS, ChatGPT 工作空间). The choice travels as the web's mikka-workspace cookie. */
export default function WorkspaceScreen() {
  const { data, reload } = useSettings()
  const home = useHome()
  const pick = async (id: string) => {
    await saveWorkspace(id)
    await Promise.all([reload(), home.reload()])
  }
  return (
    <SettingsPage title="工作区">
      <Group>{(data?.workspaces ?? []).map(w => <ChoiceRow key={w.id} label={w.name} selected={w.id === data?.workspace.id} onPress={() => void pick(w.id)} />)}</Group>
    </SettingsPage>
  )
}
