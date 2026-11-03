export type ListSnapshot<T> = { version: string; items: T[] }
export type ListPoll<T> = ListSnapshot<T> | { version: string; unchanged: true }

/** Keep the latest cache value when an in-flight unchanged response completes. */
export function mergeList<T>(current: T[], next: ListPoll<T>): T[] {
  return 'unchanged' in next ? current : next.items
}
