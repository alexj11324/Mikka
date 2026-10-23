/** Keep the newest distinct rows from indexed list branches. A global top-N is always inside the per-branch top-N. */
export function mergeIssueRows<T extends { id: string; updatedAt: Date }>(groups: readonly (readonly T[])[], limit = 100) {
  const byId = new Map<string, T>()
  for (const group of groups) {
    for (const row of group) if (!byId.has(row.id)) byId.set(row.id, row)
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()).slice(0, limit)
}
