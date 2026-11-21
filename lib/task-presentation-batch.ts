/** One transport bound for Web, Desktop and mobile. Empty collections make no request. */
export const TASK_PRESENTATION_BATCH_LIMIT = 200

export type PresentationBatch<T> = { version: 1; workspaceId: string; items: Record<string, T> }

export async function readPresentationPages<T>(workspaceId: string, ids: readonly string[],
  read: (input: { workspaceId: string; issueIds: string[] }) => Promise<PresentationBatch<T>>) {
  const unique = [...new Set(ids)]
  const items = new Map<string, T>()
  for (let index = 0; index < unique.length; index += TASK_PRESENTATION_BATCH_LIMIT) {
    const issueIds = unique.slice(index, index + TASK_PRESENTATION_BATCH_LIMIT)
    const result = await read({ workspaceId, issueIds })
    if (result.version !== 1 || result.workspaceId !== workspaceId) throw new Error('taskPresentationScopeMismatch')
    for (const id of issueIds) {
      if (Object.hasOwn(result.items, id)) items.set(id, result.items[id]!)
    }
  }
  return items
}
