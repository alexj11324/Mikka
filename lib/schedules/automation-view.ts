import type { Definition } from './contract'

/** A schedule as the 自动化 page reads it (the store's list row). */
export type AutomationView = {
  id: string
  owner_id: string
  workspace_id: string | null
  bot_id: string | null
  visibility: 'owner' | 'workspace'
  definition: Definition
  status: 'active' | 'paused' | 'cancelled' | 'completed'
  version: number
  next_at: string | Date | null
  created_at?: string | Date
  updated_at?: string | Date
  /** The creator's name in this workspace (null when they left it). */
  owner_name?: string | null
  /** Why the host paused it (the creator lost the authority it runs on); null when a person paused it or it runs. */
  disabled_reason?: string | null
  /** 接手 is offered: the reader is an owner or admin and someone else created it. */
  can_take_over?: boolean
}
export type AutomationList = { schedules: AutomationView[]; nextCursor: string | null }

/** One run. `result` and `error` are blank for a member who is neither its creator nor an owner or admin. */
export type AutomationRun = {
  id: string
  due_at: string | Date
  started_at: string | Date | null
  finished_at: string | Date | null
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  attempts: number
  error: string | null
  result: unknown
  /** The event a run started on (blank for a member who is neither its creator nor an owner or admin). */
  trigger?: { event: { event: string; repository: string; number: number | null; title: string | null; url: string | null } } | null
}
export type AutomationHistory = { occurrences: AutomationRun[] }
export type AutomationUsageDay = { day: string; runs: number; skipped: number; tasks: number; costMicroUsd: number | null }
export type AutomationUsage = { timezone: string; maxRunsPerDay: number | null; days: AutomationUsageDay[] }

/** The task a dispatch_task run made, when the reader may see it. */
export function runTask(run: Pick<AutomationRun, 'result'>): { id: string; title: string; identifier: string | null } | null {
  const value = run.result
  if (!value || typeof value !== 'object') return null
  const { id, title, identifier } = value as Record<string, unknown>
  return typeof id === 'string' && typeof title === 'string' ? { id, title, identifier: typeof identifier === 'string' ? identifier : null } : null
}
