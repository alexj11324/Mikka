import type { ChatTool } from './context'

export type ReplySegment = { kind: 'text'; text: string } | { kind: 'tools'; tools: ChatTool[] }

/**
 * A reply's words and tools in the order they happened, top to bottom: each tool after the words said before it ran
 * (its `at`, an offset into `text`). Tools with nothing said between them share one segment.
 */
export function replySegments(text: string, tools: readonly ChatTool[]): ReplySegment[] {
  const segments: ReplySegment[] = []
  let from = 0
  const words = (to: number) => {
    const piece = text.slice(from, to).trim()
    if (piece) segments.push({ kind: 'text', text: piece })
    from = to
  }
  for (const tool of tools) {
    words(Math.min(text.length, Math.max(from, tool.at ?? 0)))
    const last = segments.at(-1)
    if (last?.kind === 'tools') last.tools.push(tool)
    else segments.push({ kind: 'tools', tools: [tool] })
  }
  words(text.length)
  return segments
}
