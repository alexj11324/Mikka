import type { ChatTool } from './context'
import { projectedToolResult, toolCallMetadata } from './tool-metadata'

/** Only display metadata crosses this boundary, never message text or previews. */
export type ChatToolMetadataPart = { ordinal: number; toolCallId: string; mikkaInvalidToolCall?: true } & (
  | { type: 'tool-call'; toolName: string; target?: string; operationName?: string }
  | { type: 'tool-result'; status: 'done' | 'error'; errorCode?: string; errorDetail?: string }
)
export type ChatToolMetadataRow = { position: number; parts: ChatToolMetadataPart[] }
export type ChatToolMetadata = { baseCursor: number; prefix: string; rows: ChatToolMetadataRow[] }

type Item = { position: number; from?: string; activity?: { tools: ChatTool[] } }

/** Positions delimit the replies already proved by the prefix hash. A call id
 * is scoped to its reply, never the entire conversation. Missing, reordered or
 * ambiguous records need the existing bounded snapshot instead. */
export function restoreChatToolMetadata<T extends Item>(items: T[], rows: ChatToolMetadataRow[], after: number, cursor: number): T[] | undefined {
  const lower = Math.max(0, cursor - 199)
  if (!Array.isArray(rows) || items.some((item, index) => item.position < lower || item.position > after || index > 0 && item.position <= items[index - 1].position)) return undefined
  const restored = items.map(() => [] as ChatTool[])
  let group = -1, previousPosition = lower - 1
  for (const row of rows) {
    if (!Number.isSafeInteger(row.position) || row.position <= previousPosition || row.position < lower || row.position > after || !Array.isArray(row.parts) || !row.parts.length) return undefined
    previousPosition = row.position
    while (group + 1 < items.length && items[group + 1].position <= row.position) group++
    let ordinal = 0
    for (const part of row.parts) {
      // A pre-fix disk cache may still contain the invalid activity itself.
      // Rebuild through the bounded snapshot, which pairs and removes it.
      if (part.mikkaInvalidToolCall) return undefined
      if (!Number.isSafeInteger(part.ordinal) || part.ordinal <= ordinal || !['tool-call', 'tool-result'].includes(part.type)) return undefined
      ordinal = part.ordinal
      // The disk window can begin after an older reply's start. Those rows
      // have no cached item and cannot repair a later reply with the same id.
      if (group < 0) continue
      const item = items[group], tools = restored[group]
      if (part.type === 'tool-call') {
        const expected = item.activity?.tools[tools.length]
        if (item.from !== 'coordinator' || !expected || expected.call !== part.toolCallId || expected.name !== part.toolName || tools.some(tool => tool.call === part.toolCallId)) return undefined
        tools.push({ call: part.toolCallId, name: part.toolName, state: 'running', ...toolCallMetadata(part.toolName, undefined, part) })
      } else if (item.from === 'coordinator') {
        if (part.status !== 'done' && part.status !== 'error') return undefined
        const tool = tools.find(value => value.call === part.toolCallId)
        if (tool) Object.assign(tool, projectedToolResult(part.status, part))
      }
    }
  }
  const result: T[] = []
  for (const [index, item] of items.entries()) {
    const expected = item.activity?.tools ?? [], tools = restored[index]
    if (expected.length !== tools.length || tools.some((tool, at) => tool.state !== expected[at].state)) return undefined
    if (!expected.length) { result.push(item); continue }
    const activity = { ...item.activity, tools: tools.map((tool, at) => {
      const { target: _target, displayName: _display, errorCode: _code, errorDetail: _detail, ...held } = expected[at]
      return { ...held, ...tool }
    }) }
    result.push({ ...item, activity })
  }
  return result
}
