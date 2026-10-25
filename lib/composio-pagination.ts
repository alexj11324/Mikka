export async function listComposioPages<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | null }>, options: { signal?: AbortSignal; maxPages?: number } = {}) {
  const items: T[] = []
  const seen = new Set<string>()
  const maxPages = options.maxPages ?? 50
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid Composio pagination bound')
  let pages = 0
  let cursor: string | undefined
  do {
    options.signal?.throwIfAborted()
    if (++pages > maxPages || (cursor && seen.has(cursor))) throw new Error('Composio pagination bound exceeded')
    if (cursor) seen.add(cursor)
    const page = await fetchPage(cursor)
    options.signal?.throwIfAborted()
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}
