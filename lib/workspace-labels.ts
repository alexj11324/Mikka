import type { IssueLabel } from './issue-metadata'

/** The workspace's issue labels and their colours, for picking a rule's label (#539). */
export type WorkspaceLabel = IssueLabel

export async function listWorkspaceLabels(): Promise<WorkspaceLabel[]> {
  const { listWorkspaceIssueLabels } = await import('@/app/actions/execution-settings')
  return uniqueLabels(await listWorkspaceIssueLabels() as WorkspaceLabel[])
}

/** One entry per name, matched without case, first colour wins, sorted by name. */
export function uniqueLabels(labels: readonly WorkspaceLabel[]): WorkspaceLabel[] {
  const byName = new Map<string, WorkspaceLabel>()
  for (const label of labels) if (!byName.has(label.name.toLowerCase())) byName.set(label.name.toLowerCase(), label)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The workspace label a rule names, if it exists; rules match labels without case. */
export function findLabel(labels: readonly WorkspaceLabel[], name: string): WorkspaceLabel | undefined {
  const key = name.trim().toLowerCase()
  return labels.find(label => label.name.toLowerCase() === key)
}

/** Labels whose name contains the typed text; nothing typed lists them all. */
export function matchLabels(labels: readonly WorkspaceLabel[], query: string): WorkspaceLabel[] {
  const key = query.trim().toLowerCase()
  return key ? labels.filter(label => label.name.toLowerCase().includes(key)) : [...labels]
}
