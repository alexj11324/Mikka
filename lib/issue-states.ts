// A workspace's task states (Capy's Issue states): plain data and pure helpers, safe in the browser.
// The store is lib/issue-states-store.ts; the migration 20261120044638_workspace_issue_states.sql keeps
// `issues.status` equal to the category of `issues.state_id`.
import { z } from 'zod'
import { ISSUE_STATUS_CODES, type IssueStatus } from './issue-meta'
import { MARK_TONE_NAMES, type MarkShape, type MarkSpec, type MarkTone } from './state-mark'

export type IssueStateType = 'open' | 'closed'

/** The shapes a state may take: the status shapes plus the three attention ones; priority bars are not states. */
export const ISSUE_STATE_ICONS = ['dashed', 'empty', 'half', 'progress', 'check', 'x', 'slash', 'hand', 'question', 'alert', 'urgent'] as const satisfies readonly MarkShape[]
export type IssueStateIcon = (typeof ISSUE_STATE_ICONS)[number]
export const ISSUE_STATE_COLORS = MARK_TONE_NAMES
export const ISSUE_STATE_NAME_MAX = 60

export interface IssueStateView {
  id: string
  /** NULL: the category's own translated name. */
  name: string | null
  icon: IssueStateIcon
  color: MarkTone
  category: IssueStatus
  type: IssueStateType
  isDefault: boolean
  position: number
  /** Tasks in this state, for the delete dialog. */
  taskCount: number
}

const CLOSED: ReadonlySet<IssueStatus> = new Set(['done', 'canceled', 'duplicate'])

export function issueStateType(category: IssueStatus): IssueStateType {
  return CLOSED.has(category) ? 'closed' : 'open'
}

export function issueStateMark(state: Pick<IssueStateView, 'icon' | 'color'>): MarkSpec {
  return { shape: state.icon, tone: state.color }
}

/** The name a state shows: the person's name, else the category's name from `categoryLabel`. */
export function issueStateLabel(state: Pick<IssueStateView, 'name' | 'category'>, categoryLabel: (category: IssueStatus) => string): string {
  return state.name ?? categoryLabel(state.category)
}

/** States in their order, split as the picker and the settings page show them: Open, then Closed. */
export function groupIssueStates<T extends Pick<IssueStateView, 'type' | 'position' | 'category'>>(states: readonly T[]): { open: T[]; closed: T[] } {
  const ordered = [...states].sort((a, b) => a.position - b.position)
  return { open: ordered.filter(state => state.type === 'open'), closed: ordered.filter(state => state.type === 'closed') }
}

/** Number keys 1–9 pick the picker's states in its order (Open first, then Closed). */
export function issueStateForDigit<T extends Pick<IssueStateView, 'type' | 'position' | 'category'>>(states: readonly T[], key: string): T | undefined {
  if (!/^[1-9]$/.test(key)) return undefined
  const { open, closed } = groupIssueStates(states)
  return [...open, ...closed][Number(key) - 1]
}

/** Case-insensitive name match against the label each state shows. */
export function filterIssueStates<T extends Pick<IssueStateView, 'name' | 'category'>>(states: readonly T[], query: string, categoryLabel: (category: IssueStatus) => string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...states]
  return states.filter(state => issueStateLabel(state, categoryLabel).toLocaleLowerCase().includes(needle))
}

/** The state a task shows: its own, else its category's default (a task outside any workspace, or a stale list). */
export function taskIssueState<T extends Pick<IssueStateView, 'id' | 'category' | 'isDefault'>>(states: readonly T[], task: { stateId?: string | null; status: string }): T | undefined {
  return (task.stateId ? states.find(state => state.id === task.stateId) : undefined)
    ?? states.find(state => state.isDefault && state.category === task.status)
}

const stateName = z.string().trim().min(1).max(ISSUE_STATE_NAME_MAX)
const looks = { icon: z.enum(ISSUE_STATE_ICONS), color: z.enum(ISSUE_STATE_COLORS) }

export const createIssueStateInput = z.strictObject({ workspaceId: z.uuid(), name: stateName, category: z.enum(ISSUE_STATUS_CODES), ...looks })
/** `name: null` gives a built-in state back its translated name. The category is fixed once created. */
export const updateIssueStateInput = z.strictObject({ workspaceId: z.uuid(), id: z.uuid(), name: stateName.nullable().optional(), icon: looks.icon.optional(), color: looks.color.optional() })
export const reorderIssueStatesInput = z.strictObject({ workspaceId: z.uuid(), ids: z.array(z.uuid()).min(1).max(200) })
export const setDefaultIssueStateInput = z.strictObject({ workspaceId: z.uuid(), id: z.uuid() })
/** Capy's MoveAndDelete: the state's tasks move to `moveTo`, then the state goes. */
export const deleteIssueStateInput = z.strictObject({ workspaceId: z.uuid(), id: z.uuid(), moveTo: z.uuid() })

export type CreateIssueStateInput = z.infer<typeof createIssueStateInput>
export type UpdateIssueStateInput = z.infer<typeof updateIssueStateInput>
export type ReorderIssueStatesInput = z.infer<typeof reorderIssueStatesInput>
export type SetDefaultIssueStateInput = z.infer<typeof setDefaultIssueStateInput>
export type DeleteIssueStateInput = z.infer<typeof deleteIssueStateInput>
