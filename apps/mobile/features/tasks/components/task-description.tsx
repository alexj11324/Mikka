import { useState } from 'react'
import { View } from 'react-native'
import { Markdown } from '@/components/Markdown'
import { Row } from '@/components/settings'
import { mobileMessages } from '@/lib/messages'
import { isLegacyTaskInstruction } from '../../../../../lib/task-description'

export function TaskDescription({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!isLegacyTaskInstruction(body)) return <Markdown text={body} />
  return <View>
    <Row label={mobileMessages.Editor.executionInstructions} expanded={expanded} onPress={() => setExpanded(value => !value)} />
    {expanded && <Markdown text={body} />}
  </View>
}
