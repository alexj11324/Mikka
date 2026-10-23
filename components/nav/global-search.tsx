'use client'

import { useTranslations } from 'next-intl'
import { FolderClosed, Plus, Search, SquarePen } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import type { listProjects } from '@/app/actions/projects'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import type { SavedAgentSession } from '@/lib/agent-history'
import type { Conversation } from './conversation-list'
import { LetterAvatar } from './letter-avatar'
import { StatusDot } from './status-dot'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Project = Awaited<ReturnType<typeof listProjects>>[number]

/** The search field at the top center of the window (Figma 48:3); it opens the results below it. */
export function TopBar({ onSearch }: { onSearch: () => void }) {
  const t = useTranslations('Shell')
  return <div className="fixed inset-x-0 top-0 z-30 hidden h-10 items-center justify-center bg-shell-chrome px-4 md:flex">
    <Button variant="secondary" size="sm" aria-label={t('searchLabel')} aria-keyshortcuts="Control+k Meta+k" onClick={onSearch} className="h-7 w-110 max-w-[calc(100vw-2rem)] justify-start gap-2 rounded-lg px-3 font-normal text-muted-foreground">
      <Search data-icon="inline-start" />
      <span className="truncate">{t('searchPlaceholder')}</span>
      <ShortcutKeys keys={['mod', 'K']} className="ml-auto" />
    </Button>
  </div>
}

/**
 * ⌘K over everything (MIK-36, Figma 56:8): conversations, tasks and projects,
 * dropped down from the top bar over a dimmed page.
 */
export function GlobalSearch({ open, onOpenChange, sessions, coordinatorLine, issues, projects, onConversation, onIssue, onProject, onCreateIssue }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SavedAgentSession[]
  coordinatorLine?: string
  issues: Issue[]
  projects: Project[]
  onConversation: (conversation: Conversation) => void
  onIssue: (id: string) => boolean
  onProject: (id: string) => void
  onCreateIssue: () => void
}) {
  const t = useTranslations('Shell')
  const tNav = useTranslations('Nav')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  function pick(action: () => void) { onOpenChange(false); action() }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} overlay="dim" className="top-1.5 translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-110">
      <DialogTitle className="sr-only">{t('searchLabel')}</DialogTitle>
      <DialogDescription className="sr-only">{t('searchDescription')}</DialogDescription>
      <Command>
        <CommandInput aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} />
        <CommandList className="max-h-[min(30rem,70svh)]">
          <CommandEmpty>{t('searchEmpty')}</CommandEmpty>
          <CommandGroup heading={t('groups.conversations')}>
            <CommandItem value={`coordinator ${tNav('coordinator')} ${coordinatorLine ?? ''}`} onSelect={() => pick(() => onConversation({ kind: 'coordinator' }))} className="gap-3 py-2">
              <LetterAvatar name="Coordinator" tone="coordinator" size="search" />
              <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{tNav('coordinator')}</span>{coordinatorLine && <span className="truncate text-xs text-muted-foreground">{coordinatorLine}</span>}</span>
            </CommandItem>
            {sessions.map(session => {
              const name = session.title || tNav('untitledConversation')
              return <CommandItem key={session.id} value={`session ${session.id} ${name} ${session.preview ?? ''}`} onSelect={() => pick(() => onConversation({ kind: 'agent', sessionId: session.id }))} className="gap-3 py-2">
                <LetterAvatar name={name} size="search" />
                <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{name}</span>{session.preview && session.preview !== name && <span className="truncate text-xs text-muted-foreground">{session.preview}</span>}</span>
              </CommandItem>
            })}
          </CommandGroup>
          {issues.length > 0 && <CommandGroup heading={t('groups.tasks')}>
            {issues.map(issue => <CommandItem key={issue.id} value={`issue ${issue.id} ${issueIdentifier(issue)} ${issue.title}`} onSelect={() => { if (onIssue(issue.id)) onOpenChange(false) }} className="gap-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center"><StatusDot status={issue.status} /></span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium"><span className="text-muted-foreground tabular-nums">{issueIdentifier(issue)}</span> {issue.title}</span>
                <span className="truncate text-xs text-muted-foreground">{[issue.metadata.assignee?.name, statusLabel(issue.status)].filter(Boolean).join(' · ')}</span>
              </span>
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
            <CommandItem value="新对话 new conversation chat" onSelect={() => pick(() => onConversation({ kind: 'agent', sessionId: null }))}><SquarePen />{t('newConversation')}</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>
}
