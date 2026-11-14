import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { Pressable, View } from 'react-native'
import { ModelMenu } from '@/components/ModelMenu'
import { Text } from '@/components/Text'
import { api } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { useHome } from '@/lib/home'
import { mobileMessages } from '@/lib/messages'
import type { ModelMenu as Menu } from '@/lib/model-menu-view'
import type { ThreadDetail } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { DESKTOP_RPC_VERSION } from '../../../../../lib/desktop-rpc/version'
import { choiceFromMenu, type ThreadModelChoice } from '../../../../../lib/thread-model-choice'
import { mentionAt, referenceMarker, referenceQueryReady, sourceMentionAt, type ThreadReference } from '../../../../../lib/thread-references'
import { Composer } from './chat-composer'

async function rpc<T>(action: string, args: unknown[]): Promise<T> {
  const result = await api<{ version: number; ok: boolean; result: T }>('/api/rpc', { method: 'POST', body: { version: DESKTOP_RPC_VERSION, action, args } })
  if (!result.ok || result.version !== DESKTOP_RPC_VERSION) throw new Error('submissionUnconfirmed')
  return result.result
}

type Props = Omit<ComponentProps<typeof Composer>, 'onSend'> & {
  detail: ThreadDetail
  runId: string
  onSend: (text: string, choice?: ThreadModelChoice) => boolean
}

export function ThreadComposer(props: Props) {
  const home = useHome().data
  const scope = JSON.stringify([apiCache.context(), home?.workspace.id, props.detail.liveRunId ?? props.runId])
  return <ThreadInput key={scope} {...props} workspaceId={home?.workspace.id} />
}

function ThreadInput({ detail, runId, workspaceId, onSend, ...props }: Props & { workspaceId?: string }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [choice, setChoice] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const activeRun = detail.liveRunId ?? runId
  const issueId = detail.issueId
  const selectable = workspaceId && issueId && !detail.active && !props.sendDisabled && (detail.thread.harness === 'codex' || detail.thread.harness === 'claude_code')
  const readMenu = useCallback(() => rpc<Menu | null>('agents.getThreadContinuationModels', [issueId, activeRun]), [issueId, activeRun])
  const menu = useApi<Menu | null>(selectable ? `thread-model:${workspaceId}:${issueId}:${activeRun}` : null, { read: readMenu })
  const option = selectable && menu.data ? menu.data.groups.flatMap(group => group.options).find(row => row.id === choice) : undefined
  const group = option && menu.data?.groups.find(entry => entry.options.includes(option))
  const currentMenu = menu.data && option && group ? { ...menu.data, current: { ...menu.data.current, id: option.id, modelId: option.modelId, kind: group.kind, credentialLabel: group.credentialLabel } } : menu.data
  const scopeFile = sourceMentionAt(text, caret)
  const mention = mentionAt(text, caret)
  const kind = mention?.kind, query = mention?.query
  const signature = JSON.stringify([workspaceId, kind, query])
  const [lookup, setLookup] = useState<{ key: string; items?: ThreadReference[] } | null>(null)
  const searching = Boolean(workspaceId && mention && referenceQueryReady(mention.query) && !props.sendDisabled)
  useEffect(() => {
    if (!searching || query === undefined) return
    let current = true
    const timer = setTimeout(() => {
      const args = kind ? [workspaceId, query, kind] : [workspaceId, query]
      void rpc<ThreadReference[]>('task-runs.findThreadReferences', args).then(items => {
        if (current) setLookup({ key: signature, items })
      }, () => { if (current) setLookup({ key: signature }) })
    }, 160)
    return () => { current = false; clearTimeout(timer) }
  }, [searching, kind, query, workspaceId, signature, retry])
  const references = mobileMessages.ThreadReferences
  const found = lookup?.key === signature ? lookup : null
  const copy = mobileMessages.IssueThreads
  const selected = detail.composerModel?.selectedModel, served = detail.composerModel?.servedModel
  const model = selectable && (currentMenu || menu.error || menu.loading) ? <ModelMenu model={{
    menu: currentMenu, busy: false, choosing: null, loading: menu.loading, refreshing: menu.loading, refreshFailed: Boolean(menu.error),
    choose: id => setChoice(id), retryRead: menu.reload, refresh: menu.reload,
  }} label={option?.modelId || undefined} /> : null
  const notices = <View>
    <Text>{served || selected || copy.composerModelUnknown}</Text>
    {selected && served && selected !== served && <Text>{copy.composerModelRequested.replace('{model}', selected)}</Text>}
    {scopeFile && <Text>{references.sourceUnavailable}</Text>}
    {searching && mention && <View accessibilityLabel={references.references}>
      {!found ? <Text>{references.searching}</Text> : !found.items ? <Pressable accessibilityRole="button" onPress={() => { setLookup(null); setRetry(n => n + 1) }}><Text>{references.error} · {mobileMessages.Common.retry}</Text></Pressable>
        : found.items.length ? found.items.map(item => <Pressable key={item.kind + item.id} accessibilityRole="button" onPress={() => {
          const insert = referenceMarker(item) + ' '
          setText(text.slice(0, mention.from) + insert + text.slice(mention.end))
          setCaret(mention.from + insert.length)
        }}><Text>{references[item.kind]} · {item.title}</Text></Pressable>) : <Text>{references.empty}</Text>}
    </View>}
  </View>
  return <Composer {...props} value={text} onChangeText={setText} onCaretChange={setCaret} notice={notices} accessory={model}
    onSend={message => {
      const accepted = onSend(message, option ? choiceFromMenu(option.id) ?? undefined : undefined)
      if (accepted) setChoice(null)
      return accepted
    }} />
}
