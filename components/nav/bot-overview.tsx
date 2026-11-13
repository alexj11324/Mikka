'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { toast } from 'sonner'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { E2BKeyDialog, useE2BKeyStatus } from '@/components/settings/e2b-key-dialog'
import { ComputerScreen } from '@/components/computer/computer-screen'
import { ComputerViewer } from '@/components/computer/computer-viewer'
import { deleteLibraryFile, fetchBotLibrary } from '@/lib/bot-library'
import { BOT_COLORS, BOT_NAME_MAX, BOT_SHAPES } from '@/lib/bot-shapes'
import { isMockedComputer } from '@/lib/computer/client'
import { PR_GROUPS, groupThreads, pullRequestsOf } from '@/lib/thread-groups'
import { useActionError } from '@/lib/use-action-error'
import { usePresence } from '@/lib/use-presence'
import { DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from './bot-avatar'
import { BotLookPicker } from './bot-look-picker'
import { useBotPublicRole } from './bot-public-role-editor'
import { useSaveBot } from './use-save-bot'
import { BotOverview } from '@ui-slot/bot-overview'
import type { BotOverviewItem, BotOverviewProps, BotOverviewTab } from '@/components/slots/bot-overview-contract'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

const known = <T extends string>(value: string | undefined, options: readonly T[], fallback: T) => (options as readonly string[]).includes(value ?? '') ? value as T : fallback

/** Whether `text` contains the search, ignoring case; an empty search matches everything. */
const matches = (query: string, ...texts: (string | null | undefined)[]) => {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || texts.some(text => text?.toLocaleLowerCase().includes(needle))
}

/**
 * 资料库: the documents the threads this bot dispatched handed over, the same list as the phone's (decision
 * 2026-11-01-0050); `botId` null is the Coordinator's. Each is the person's own, so each can be deleted (after a
 * confirmation, since nothing brings it back); a failed delete says so in a toast. `enabled` false reads nothing.
 */
export function useBotLibrary(botId: string | null, enabled = true) {
  const t = useTranslations('Shell.panel')
  const { data, error, mutate } = useSWR(enabled ? ['bot-library', botId ?? 'coordinator'] : null, () => fetchBotLibrary(botId))
  const items = (data ?? []).map(file => ({ id: file.id, label: file.title }))
  async function remove(item: BotOverviewItem) {
    try {
      await deleteLibraryFile(item.id)
      await mutate(files => files?.filter(file => file.id !== item.id), { revalidate: true })
    } catch {
      toast.error(t('deleteFileFailed', { name: item.label }))
    }
  }
  return { items, loadError: !!error && !data, remove }
}

/** An ordinary bot's authorized name and appearance commands. */
function useBotEdits(botId: string, color?: string, shape?: string): NonNullable<BotOverviewProps['edit']> {
  const t = useTranslations('Shell.panel')
  const actionError = useActionError()
  const saveBot = useSaveBot()
  const failed = (failure: unknown) => actionError(failure instanceof Error ? failure.message : null)
  const tone = known(color, BOT_COLORS, DEFAULT_BOT_COLOR)
  const form = known(shape, BOT_SHAPES, DEFAULT_BOT_SHAPE)
  async function look(patch: { color?: string; shape?: string }) {
    try { await saveBot(botId, patch as { color?: BotColor; shape?: BotShape }); return null } catch (failure) { return failed(failure) }
  }
  return {
    async rename(name) {
      if (!name.trim()) return t('nameRequired')
      if (name.trim().length > BOT_NAME_MAX) return t('nameTooLong', { max: BOT_NAME_MAX })
      try { await saveBot(botId, { name: name.trim() }); return null } catch (failure) { return failed(failure) }
    },
    look,
    picker: ({ onError }) => <BotLookPicker color={tone} shape={form}
      onColor={next => { void look({ color: next }).then(onError) }} onShape={next => { void look({ shape: next }).then(onError) }} />,
  }
}

/** 电脑, as AgentComputer gives it: the person's E2B key decides between the screen and 添加 E2B API Key. */
function useComputer(target: { botId: string; name: string } | null, workspaceId: string | undefined, visible: boolean) {
  const [viewing, setViewing] = useState(false)
  const [adding, setAdding] = useState(false)
  const keyDialog = usePresence(adding)
  const mocked = target ? isMockedComputer(target.botId) : true
  const status = useE2BKeyStatus(target && !mocked && (visible || viewing || adding) ? workspaceId : null)
  const key = status.data && !status.data.error ? status.data : null
  if (!target) return { computer: null, dialogs: null }
  const loading = !mocked && !status.data && !status.error
  const computer: BotOverviewProps['computer'] = {
    name: target.name,
    state: loading ? 'loading' : key?.configured === false ? 'missing' : 'ready',
    screen: overlay => <ComputerScreen botId={target.botId} name={target.name}>{overlay}</ComputerScreen>,
    onOpen: () => setViewing(true),
    onAddKey: () => setAdding(true),
  }
  const dialogs = <>
    {viewing && <ComputerViewer botId={target.botId} name={target.name} open={viewing} onOpenChange={setViewing} />}
    {keyDialog.value && <E2BKeyDialog workspaceId={workspaceId} open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={false} onClose={changed => { setAdding(false); if (changed) void status.mutate() }} />}
  </>
  return { computer, dialogs }
}

function RoleOf({ botId, workspaceId, visible, children }: { botId: string; workspaceId?: string; visible: boolean; children: (role: BotOverviewProps['details']['role']) => ReactNode }) {
  return children(useBotPublicRole(botId, workspaceId, visible))
}

function EditsOf({ botId, color, shape, children }: { botId: string; color?: string; shape?: string; children: (edit: BotOverviewProps['edit']) => ReactNode }) {
  return children(useBotEdits(botId, color, shape))
}

/**
 * The frame tab, standalone column and sheet share the Bot's name, appearance, public role,
 * library, pull requests, computer and edit commands.
 */
export function BotOverviewBody({ conversation, tabs, tab, onTab, query, onQuery, workspaceId, threads, issues, tasks, computer: target }: {
  conversation: BotOverviewProps['conversation']
  tabs: { id: BotOverviewTab; label: string }[]
  tab: BotOverviewTab
  onTab: (tab: BotOverviewTab) => void
  query: string | null
  onQuery: (query: string | null) => void
  workspaceId?: string
  /** The threads this bot dispatched. */
  threads: Thread[]
  issues: Issue[]
  tasks: ReactNode
  computer: { botId: string; name: string } | null
}) {
  const t = useTranslations('Shell.panel')
  const botId = conversation.kind === 'bot' ? conversation.id ?? null : null
  const { computer, dialogs } = useComputer(target, workspaceId, tab === 'computer')
  // A bot's or the Coordinator's own documents; an older chat has no library.
  const own = botId !== null || conversation.kind === 'coordinator'
  const files = useBotLibrary(botId, own && tab === 'details')
  const library = { items: files.items, loadError: files.loadError, ...(own ? { onDelete: files.remove } : {}) }
  const all = pullRequestsOf(threads, issues)
  const rows = all.filter(row => {
    const issue = issues.find(item => item.id === row.issueId)
    return matches(query ?? '', issue?.title, `#${row.number}`, issue?.identifier)
  })
  const pullRequests = {
    total: all.length,
    groups: PR_GROUPS.map(group => {
      const list = rows.filter(row => row.group === group)
      return { id: group, label: t(`prGroup.${group}`, { count: list.length }), rows: list.map(row => {
        const issue = issues.find(item => item.id === row.issueId)
        return { url: row.url, title: issue?.title ?? '', number: row.number, identifier: issue?.identifier ?? undefined, state: row.state }
      }) }
    }).filter(group => group.rows.length),
  }
  // The same folding as the lists: a task counts once, by its newest thread.
  const grouped = groupThreads(threads, id => issues.find(item => item.id === id))
  const glance = { running: grouped.running.length, waiting: grouped.waiting.length,
    pullRequests: { review: all.filter(row => row.group === 'review').length, running: all.filter(row => row.group === 'running').length } }
  const draw = (role: BotOverviewProps['details']['role'], edit: BotOverviewProps['edit']) => <BotOverview conversation={conversation} tabs={tabs} tab={tab} onTab={onTab} query={query} onQuery={onQuery}
    edit={edit} details={{ role, routines: [], library }} glance={glance} tasks={tasks} pullRequests={pullRequests} computer={computer} dialogs={dialogs} />
  if (!botId) return draw(null, null)
  return <RoleOf key={botId} botId={botId} workspaceId={workspaceId} visible={tab === 'details'}>{role =>
    <EditsOf botId={botId} color={conversation.color} shape={conversation.shape}>{edit => draw(role, edit)}</EditsOf>}</RoleOf>
}
