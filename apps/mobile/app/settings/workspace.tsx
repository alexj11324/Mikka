import { useState } from 'react'
import { ChoiceRow, SettingsPage } from '@/components/settings'
import { Group } from '@/components/ui'
import { me, workspaces } from '@/lib/mock'

/** 工作区 picker (Comma iOS, ChatGPT 工作空间). */
export default function WorkspaceScreen() {
  const [current, setCurrent] = useState(me.workspace)
  return (
    <SettingsPage title="工作区">
      <Group>{workspaces.map(w => <ChoiceRow key={w} label={w} selected={w === current} onPress={() => setCurrent(w)} />)}</Group>
    </SettingsPage>
  )
}
