import {estimateTokens,promptMessages,COMPACT_AT_TOKENS,KEEP_RECENT_TOKENS,type StoredMessage} from '../../lib/coordinator/context'
import type {SummaryTrust} from '../../lib/coordinator/message-safety'

// Reconstructs historical summary partitions for provenance/reader regressions.
// Production session compaction is owned by Eve.
/**
 * The last position to fold into the summary, or null when the history still
 * fits. The cut always lands just before a user message, so a tool call is
 * never separated from its result, and keeps about `KEEP_RECENT_TOKENS` of
 * recent conversation.
 */
export function compactionCut(summary: string | null, messages: readonly StoredMessage[], trust?: SummaryTrust): number | null {
  if (estimateTokens(promptMessages(summary, messages, trust)) < COMPACT_AT_TOKENS) return null
  let kept = 0
  let cut: number | null = null
  for (let index = messages.length - 1; index > 0; index--) {
    kept += estimateTokens([messages[index].message])
    if (messages[index].message.role === 'user') {
      cut = messages[index - 1].position
      if (kept >= KEEP_RECENT_TOKENS) break
    }
  }
  return cut
}

