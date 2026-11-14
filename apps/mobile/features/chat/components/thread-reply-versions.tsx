import { randomUUID } from 'expo-crypto'
import { useRef, useState } from 'react'
import { Linking, TextInput, View } from 'react-native'
import { GlassButton } from '@/components/GlassButton'
import { Segmented } from '@/components/Segmented'
import { Text } from '@/components/Text'
import { api, ApiError } from '@/lib/api'
import { mobileMessages } from '@/lib/messages'
import type { ThreadDetail } from '@/lib/types'
import { DESKTOP_RPC_VERSION } from '../../../../../lib/desktop-rpc/wire'
import { pullRequestSchema } from '../../../../../lib/issue-metadata'

type Anchor = NonNullable<ThreadDetail['versionAnchors']>[string]
type Version = { id: string; text: string; anchorRunId: string; anchorKey: string; resultRunId: string | null; output: string | null; originalOutput: string | null; pullRequest: string | null; originalPullRequest: string | null }
type Props = { detail: ThreadDetail | undefined; runId: string; itemId: string; text: string; reload: () => Promise<void>; working: boolean }
const copy = mobileMessages.IssueThreads
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)
const nullableText = (value: unknown) => value === null || typeof value === 'string'
function isVersion(row: unknown): row is Version {
  return isRecord(row) && isId(row.id) && isId(row.anchorRunId) && typeof row.anchorKey === 'string' && typeof row.text === 'string'
    && (row.resultRunId === null || isId(row.resultRunId)) && nullableText(row.output) && nullableText(row.originalOutput)
    && nullableText(row.pullRequest) && nullableText(row.originalPullRequest)
}
async function rpc(action: string, args: unknown[]) {
  const receipt = await api<unknown>('/api/rpc', { method: 'POST', body: { version: DESKTOP_RPC_VERSION, action, args } })
  if (!isRecord(receipt) || receipt.version !== DESKTOP_RPC_VERSION) throw new Error('submissionUnconfirmed')
  if (receipt.ok !== true) throw new Error(isRecord(receipt.error) && typeof receipt.error.code === 'string' ? receipt.error.code : 'submissionUnconfirmed')
  if (isRecord(receipt.result) && typeof receipt.result.error === 'string') throw new Error(receipt.result.error)
  return receipt.result
}

export function MobileReplyVersions({ detail, runId, itemId, ...props }: Props) {
  const anchor = detail?.versionAnchors?.[itemId]
  if (!anchor || !detail?.issueId) return null
  return <VersionPicker key={JSON.stringify([detail.issueId, runId, anchor.runId, anchor.key, anchor.operation])}
    {...props} issueId={detail.issueId} runId={runId} anchor={anchor} />
}

function VersionPicker({ issueId, runId, anchor, text, reload, working }: Pick<Props, 'text' | 'reload' | 'working' | 'runId'> & { issueId: string; anchor: Anchor }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [versions, setVersions] = useState<Version[] | null>(null), [selected, setSelected] = useState('original'), [draft, setDraft] = useState(text)
  const submitting = useRef(false), revision = useRef(0), request = useRef<{ id: string; text: string } | null>(null)
  const selectedVersion = versions?.find(row => row.id === selected)
  const original = versions?.[0]
  const output = selectedVersion ? selectedVersion.output : original?.originalOutput ?? (anchor.operation === 'rerun' ? text : null)
  const pull = pullRequestSchema.shape.url.safeParse(selectedVersion ? selectedVersion.pullRequest : original?.originalPullRequest)
  const label = anchor.operation === 'edit' ? copy.versionEdit : copy.versionRerun
  const showError = (failure: unknown) => {
    const code = failure instanceof Error ? failure.message : ''
    const denied = (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) || ['authRequired', 'runNotFound', 'workspaceAccessDenied'].includes(code)
    if (denied) { setVersions(null); setSelected('original') }
    setError((mobileMessages.Errors as Record<string, string>)[code] ?? (denied ? mobileMessages.Coordinator.sendAccessDenied : mobileMessages.Coordinator.sendUncertain))
  }
  async function read() {
    const rows = await rpc('agents.getThreadReplyVersions', [issueId, runId])
    if (!Array.isArray(rows) || !rows.every(isVersion)) throw new Error('submissionUnconfirmed')
    return rows.filter(row => row.anchorRunId === anchor.runId && row.anchorKey === anchor.key)
  }
  function toggle() {
    if (submitting.current) return
    const current = ++revision.current
    setOpen(!open); setError('')
    if (open) return
    setVersions(null); setSelected('original'); setDraft(text)
    void read().then(rows => { if (current === revision.current) setVersions(rows) }).catch(failure => { if (current === revision.current) showError(failure) })
  }
  async function submit() {
    const value = anchor.operation === 'edit' ? draft.trim() : ''
    if (submitting.current || working || !versions || (anchor.operation === 'edit' && !value)) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const operation = request.current?.text === value ? request.current : { id: randomUUID(), text: value }
      request.current = operation
      const change = { anchorRunId: anchor.runId, anchorKey: anchor.key, requestId: operation.id, operation: anchor.operation, ...(anchor.operation === 'edit' ? { text: value } : {}) }
      const receipt = await rpc('agents.createThreadReplyVersion', [{ issueId, runId, change }])
      if (!isRecord(receipt) || !isId(receipt.versionId) || !isId(receipt.runId)) throw new Error('submissionUnconfirmed')
      const rows = await read()
      const saved = rows.find(row => row.id === receipt.versionId)
      if (!saved || (saved.resultRunId !== null && saved.resultRunId !== receipt.runId)) throw new Error('submissionUnconfirmed')
      setVersions(rows); setSelected(saved.id); setDraft(saved.text)
      await reload()
      request.current = null
    } catch (failure) { showError(failure) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <View style={{ gap: 4 }}>
    <GlassButton label={open ? copy.versionClose : label} disabled={busy} onPress={toggle} />
    {open && <>
      <Text>{copy.versionEffects}</Text>
      {versions && versions.length > 0 && <Segmented options={[{ value: 'original', label: copy.versionOriginal }, ...versions.map((row, i) => ({ value: row.id, label: copy.versionNumber.replace('{number}', String(i + 2)) }))]}
        value={selected} onChange={id => { setSelected(id); setDraft(versions.find(row => row.id === id)?.text ?? text) }} />}
      {anchor.operation === 'edit' && <TextInput multiline editable={!busy} accessibilityLabel={label} value={draft} maxLength={10000} onChangeText={setDraft} />}
      {versions && (output || selectedVersion) ? <Text selectable>{output ?? copy.versionPending}</Text> : null}
      {versions && pull.success ? <GlassButton label={copy.versionPullRequest} onPress={() => void Linking.openURL(pull.data).catch(showError)} /> : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <GlassButton label={copy.versionRun} busy={busy} disabled={!versions || busy || working || (anchor.operation === 'edit' && !draft.trim())} onPress={() => void submit()} />
    </>}
  </View>
}
