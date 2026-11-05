import type { GroupMessage } from './types'

/** The poll replaces overlapping snapshots, while already read history survives the moving 100-message window. */
export function mergeGroupMessages(previous: GroupMessage[], incoming: GroupMessage[]): GroupMessage[] {
  const messages = new Map(previous.map(message => [message.id, message]))
  for (const message of incoming) messages.set(message.id, message)
  return [...messages.values()].sort((a, b) => BigInt(a.position) < BigInt(b.position) ? -1 : BigInt(a.position) > BigInt(b.position) ? 1 : 0)
}

/** The server caps a reactions read at 100 IDs, including when history is expanded. */
export function groupReactionPaths(ids: string[]): string[] {
  const unique = [...new Set(ids)]
  const paths: string[] = []
  for (let start = 0; start < unique.length; start += 100) paths.push(`/api/mobile/reactions?ids=${unique.slice(start, start + 100).join(',')}`)
  return paths
}
