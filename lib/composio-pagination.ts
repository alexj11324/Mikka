export async function listComposioPages<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | null }>) {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}
