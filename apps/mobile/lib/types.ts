/** The shapes app/api/mobile/* and /api/suggestions return (see those routes on the server). */
export type Source = 'gmail' | 'github' | 'slack' | 'notion' | 'linear' | 'googlecalendar'
export type MachineKind = 'cloud' | 'laptop' | 'server'
export type ThreadStatus = 'running' | 'waiting' | 'failed' | 'done' | 'stopped'

export interface Person { id: string; name: string; email: string; image: string | null }
export interface Workspace { id: string; name: string }

export interface HomeBot { id: string; name: string; color: string; shape: string; line: string | null; at: string | null; working: boolean }

export interface Home {
  user: Person
  workspace: Workspace
  workspaces: Workspace[]
  bots: HomeBot[]
  threads: { running: number; waiting: number }
  suggestions: number
}

export interface IssueSource { kind: 'issue'; id: string; identifier: string | null; number: number | null; title: string; status: string }
export interface RunSource {
  kind: 'run'; id: string; name: string; agentName: string; harness: string; status: string
  issue: { id: string; identifier: string | null; number: number | null; title: string } | null
}
export type CitationSource = IssueSource | RunSource

export interface ChatItem {
  id?: string
  position: number
  from: 'person' | 'coordinator' | 'event'
  text: string
  threads: string[]
  artifacts: string[]
  createdAt: string
  pending?: true
}

export interface Chat {
  enabled: boolean
  working: boolean
  error: string | null
  items: ChatItem[]
  sources: Record<string, CitationSource>
  artifacts: Record<string, { id: string; title: string }>
}

export interface Thread {
  id: string
  name: string
  status: ThreadStatus
  by: string
  harness: string
  device: { id: string; name: string; kind: MachineKind } | null
  createdAt: string
  finishedAt: string | null
}

export interface Threads { threads: Thread[]; devices: { id: string; name: string; kind: MachineKind; online: boolean }[] }

export type ThreadItem =
  | { kind: 'agent'; id: string; text: string; at: number }
  | { kind: 'steps'; id: string; count: number; at: number }
  | { kind: 'error'; id: string; text: string; at: number }
  | { kind: 'person'; id: string; text: string; mine: boolean; at: number }

export interface ThreadDetail { thread: Thread; active: boolean; summary: string | null; error: string | null; items: ThreadItem[] }

export interface Suggestion { id: string; source: Source; action: string; title: string; url: string | null; actor: string | null; occurredAt: string }
export interface Suggestions { groups: { source: Source; items: Suggestion[] }[] }

export interface Task { id: string; identifier: string | null; title: string; status: string; priority: string; owner: string | null; updatedAt: string }

export interface Preferences {
  proactive: boolean
  pushDecide: boolean
  pushReview: boolean
  pushFinished: boolean
  pushBriefing: boolean
  pushWhen: 'always' | 'away'
  memoryEnabled: boolean
}

export interface Settings {
  user: Person
  workspace: Workspace
  workspaces: Workspace[]
  preferences: Preferences
  memory: string
  apps: { app: Source; connected: boolean; account: string | null }[]
}

/** A run's name as the app shows it: its task as "MIK-11 群聊建表" when it has one (glossary), else its own name. */
export function runTitle(run: RunSource): string {
  if (!run.issue) return run.name
  const key = run.issue.identifier ?? (run.issue.number === null ? null : `#${run.issue.number}`)
  return key ? `${key} ${run.issue.title}` : run.issue.title
}
