import type { TaskMenuItem } from '@/components/slots/task-detail-contract'
import { ISSUE_STATUS_CODES, type IssueStatus } from '@/lib/issue-meta'
import { groupIssueStates, issueStateLabel, taskIssueState, type IssueStateView } from '@/lib/issue-states'
import { Mark } from './state-mark'

/**
 * A task's Status menu as the task page's menus take it (decision 2026-11-19-2115): the workspace's states, Open then
 * Closed with a line between, each picking its own state. Until the states load (or outside a workspace) the seven
 * categories stand in and pick by category alone.
 */
export function issueStateMenuItems(states: readonly IssueStateView[] | null, task: { status: string; stateId?: string | null }, categoryLabel: (category: IssueStatus) => string, onStatus: (status: IssueStatus, stateId?: string | null) => void): TaskMenuItem[] {
  if (!states?.length) return ISSUE_STATUS_CODES.map(value => ({ id: value, label: categoryLabel(value), mark: { kind: 'status', value }, checked: value === task.status, onSelect: () => onStatus(value) }))
  const current = taskIssueState(states, task)
  const { open, closed } = groupIssueStates(states)
  return [...open, ...closed].map((state, index) => ({
    id: state.id, label: issueStateLabel(state, categoryLabel), mark: { kind: 'node', node: <Mark shape={state.icon} tone={state.color} /> },
    checked: state.id === current?.id, divider: index === open.length && index > 0,
    onSelect: () => onStatus(state.category, state.id),
  }))
}
