'use client'

import { useTranslations } from 'next-intl'
import { Bot, FolderClosed, ListTodo, Plus, Search, SquarePen } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import type { listProjects } from '@/app/actions/projects'
import type { BotView } from '@/app/actions/bots'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/reui/badge'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { statusTone, type StatusTone } from '@/lib/status-appearance'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import type { SavedAgentSession } from '@/lib/agent-history'
import type { ChatTarget } from './bot-list'
import { LetterAvatar } from './letter-avatar'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Project = Awaited<ReturnType<typeof listProjects>>[number]

const STATUS_BADGES = { neutral: 'outline', warning: 'warning-light', info: 'info-light', success: 'success-light', destructive: 'destructive-light', focus: 'focus-light' } as const satisfies Record<StatusTone, string>

/** The search pill centered in the window bar (Comma's shell); it opens the results below it. */
export function SearchPill({ onSearch }: { onSearch: () => void }) {
  const t = useTranslations('Shell')
  return <Button variant="outline" size="sm" aria-label={t('searchLabel')} aria-keyshortcuts="Control+k Meta+k" onClick={onSearch} className="h-7 w-full min-w-0 justify-center gap-2 rounded-full bg-background px-3 text-xs font-normal text-muted-foreground shadow-xs hover:text-foreground">
    <Search data-icon="inline-start" />
    <span className="truncate">{t('searchPlaceholder')}</span>
    <ShortcutKeys keys={['mod', 'K']} />
  </Button>
}

/**
 * ⌘K over everything (MIK-36): bots, older chats, tasks and projects. Built on
 * reUI's command palette (c-command-5 / c-command-8), centered in the window
 * with a fixed-height list so the dialog doesn't jump while filtering.
 */
export function GlobalSearch({ open, onOpenChange, bots, sessions, coordinatorLine, issues, projects, onChat, onNewBot, onIssue, onProject, onCreateIssue }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  bots: BotView[]
  /** Older chats that belong to no bot; bots' own chats open through their bot. */
  sessions: SavedAgentSession[]
  coordinatorLine?: string
  issues: Issue[]
  projects: Project[]
  onChat: (target: ChatTarget) => void
  onNewBot: () => void
  onIssue: (id: string) => boolean
  onProject: (id: string) => void
  onCreateIssue: () => void
}) {
  const t = useTranslations('Shell')
  const tNav = useTranslations('Nav')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  function pick(action: () => void) { onOpenChange(false); action() }
  return <CommandDialog open={open} onOpenChange={onOpenChange} title={t('searchLabel')} description={t('searchDescription')} className="top-1/2 -translate-y-1/2 sm:max-w-xl">
      <Command className="**:data-[selected=true]:bg-muted">
        <CommandInput aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} />
        <CommandList className="h-[min(26rem,60svh)] max-h-none">
          <CommandEmpty>{t('searchEmpty')}</CommandEmpty>
          <CommandGroup heading={t('groups.bots')}>
            <CommandItem value={`coordinator ${tNav('coordinator')} ${coordinatorLine ?? ''}`} onSelect={() => pick(() => onChat({ kind: 'coordinator' }))} className="gap-3 py-2">
              <CoordinatorAvatar size="search" />
              <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{tNav('coordinator')}</span>{coordinatorLine && <span className="truncate text-xs text-muted-foreground">{coordinatorLine}</span>}</span>
            </CommandItem>
            {bots.map(bot => <CommandItem key={bot.id} value={`bot ${bot.id} ${bot.name}`} onSelect={() => pick(() => onChat({ kind: 'bot', botId: bot.id }))} className="gap-3 py-2">
              <BotAvatar color={bot.color} shape={bot.shape} size="search" />
              <span className="truncate font-medium">{bot.name}</span>
            </CommandItem>)}
          </CommandGroup>
          {sessions.length > 0 && <CommandGroup heading={t('groups.conversations')}>
            {sessions.map(session => {
              const name = session.title || tNav('untitledConversation')
              return <CommandItem key={session.id} value={`session ${session.id} ${name} ${session.preview ?? ''}`} onSelect={() => pick(() => onChat({ kind: 'agent', sessionId: session.id }))} className="gap-3 py-2">
                <LetterAvatar name={name} size="search" />
                <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{name}</span>{session.preview && session.preview !== name && <span className="truncate text-xs text-muted-foreground">{session.preview}</span>}</span>
              </CommandItem>
            })}
          </CommandGroup>}
          {issues.length > 0 && <CommandGroup heading={t('groups.tasks')}>
            {issues.map(issue => <CommandItem key={issue.id} value={`issue ${issue.id} ${issueIdentifier(issue)} ${issue.title}`} onSelect={() => { if (onIssue(issue.id)) onOpenChange(false) }} className="gap-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><ListTodo /></span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium"><span className="text-muted-foreground tabular-nums">{issueIdentifier(issue)}</span> {issue.title}</span>
                {issue.metadata.assignee?.name && <span className="truncate text-xs text-muted-foreground">{issue.metadata.assignee.name}</span>}
              </span>
              <CommandShortcut className="tracking-normal"><Badge variant={STATUS_BADGES[statusTone(issue.status)]} size="sm">{statusLabel(issue.status)}</Badge></CommandShortcut>
            </CommandItem>)}
          </CommandGroup>}
          {projects.length > 0 && <CommandGroup heading={t('groups.projects')}>
            {projects.map(project => <CommandItem key={project.id} value={`project ${project.id} ${project.name} ${project.summary}`} onSelect={() => pick(() => onProject(project.id))} className="gap-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><FolderClosed /></span>
              <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{project.name}</span>{project.summary && <span className="truncate text-xs text-muted-foreground">{project.summary}</span>}</span>
            </CommandItem>)}
          </CommandGroup>}
          {/* i18n-ignore: bilingual search keywords, not rendered */}
          <CommandGroup heading={t('groups.actions')}>
            {/* i18n-ignore: bilingual search keywords */}
            <CommandItem value="新建任务 create issue new task" onSelect={() => pick(onCreateIssue)}><Plus />{t('newTask')}</CommandItem>
            {/* i18n-ignore: bilingual search keywords */}
            <CommandItem value="新建 bot create new bot" onSelect={() => pick(onNewBot)}><Bot />{t('newBot.title')}</CommandItem>
            {/* i18n-ignore: bilingual search keywords */}
            <CommandItem value="新对话 new conversation chat" onSelect={() => pick(() => onChat({ kind: 'agent', sessionId: null }))}><SquarePen />{t('newConversation')}</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
}
