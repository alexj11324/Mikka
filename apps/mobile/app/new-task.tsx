import { useRef, useState } from 'react'
import { ScrollView, StyleSheet, TextInput } from 'react-native'
import { randomUUID } from 'expo-crypto'
import { useRouter } from 'expo-router'
import { Check, X } from 'lucide-react-native'
import { NavBar } from '@/components/NavBar'
import { Segmented } from '@/components/Segmented'
import { Text } from '@/components/Text'
import { Field } from '@/components/ui'
import { apiConnection } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { useHome } from '@/lib/home'
import { mobileMessages } from '@/lib/messages'
import { submitMobileTask, type TaskCreationIntent } from '@/lib/task-create'
import { colors, font } from '@/lib/theme'
import { TASK_TITLE_MAX } from '../../../lib/task-title-input'

const copy = mobileMessages.Shell.newTaskDialog

export default function NewTask() {
  const { data: home } = useHome()
  const router = useRouter()
  const [intent, setIntent] = useState<TaskCreationIntent>('create_only')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const requests = useRef(new Map<string, { id: string; delivered?: true }>())
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(false)
  const text = description.trim() || title.trim()
  async function submit() {
    if (!home || !text || pending.current) return
    const draft = { intent, title: title.trim(), description: text, workspaceId: home.workspace.id }
    const context = apiCache.context()
    const key = JSON.stringify([context, home.user.id, draft])
    const operation = requests.current.get(key) ?? { id: randomUUID() }
    requests.current.set(key, operation)
    pending.current = true
    setBusy(true)
    setProblem(false)
    try {
      const id = await submitMobileTask(draft, operation, apiConnection())
      requests.current.delete(key)
      apiCache.commit(context, () => router.replace({ pathname: '/task/[id]', params: { id } }))
    } catch {
      apiCache.commit(context, () => setProblem(true))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const label = intent === 'create_only' ? copy.createOnly : copy.createAndDispatch
  return <>
    <NavBar fade={false} title={copy.title}
      left={{ icon: 'xmark', label: mobileMessages.Common.cancel, disabled: busy, web: <X size={20} color={colors.ink} />, onPress: () => router.back() }}
      right={{ icon: 'checkmark', label: busy ? copy.sending : label, disabled: busy || !text || !home, busy, prominent: true, web: <Check size={20} color={colors.accent} />, onPress: () => void submit() }} />
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.page} contentContainerStyle={styles.body}>
      <Segmented value={intent} onChange={next => { if (!pending.current) setIntent(next) }} options={[{ value: 'create_only', label: copy.createOnly }, { value: 'create_and_dispatch', label: copy.createAndDispatch }]} />
      <Field style={styles.field}><TextInput value={title} editable={!busy} onChangeText={setTitle} maxLength={TASK_TITLE_MAX} accessibilityLabel={copy.titleLabel}
        autoFocus placeholder={copy.backlogTitlePlaceholder} placeholderTextColor={colors.secondary} style={styles.input} /></Field>
      <Field style={styles.field}><TextInput value={description} editable={!busy} onChangeText={setDescription} maxLength={8000} accessibilityLabel={copy.label}
        multiline placeholder={copy.placeholder} placeholderTextColor={colors.secondary} style={[styles.input, styles.description]} /></Field>
      {problem ? <Text accessibilityRole="alert" style={styles.problem}>{mobileMessages.Coordinator.sendUncertain}</Text> : null}
    </ScrollView>
  </>
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  body: { padding: 20, gap: 12 },
  field: { padding: 14, borderRadius: 20, backgroundColor: colors.bubble },
  input: { fontFamily: font, fontSize: 17, color: colors.text },
  description: { minHeight: 96, textAlignVertical: 'top' },
  problem: { color: colors.danger },
})
