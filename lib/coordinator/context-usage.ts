import { COMPACT_AT_TOKENS, estimateTokens, promptMessages, KEEP_RECENT_TOKENS, type StoredMessage } from './context'
// `SummaryTrust` is declared in message-safety and only consumed by context;
// taking it from its own module is what typechecks.
import type { SummaryTrust } from './message-safety'

/** Historical Chat payload estimate retained for compatibility readers.
 * This neither triggers compaction nor selects a model; Eve owns current
 * context and its provider-reported session usage. Values use the old wire
 * shape and its character heuristic, not a measured provider context window.
 */
export interface ConversationUsage {
  /** Always true: a character heuristic, not the provider's tokenizer. */
  estimated: true
  /** Estimated tokens the next prompt would carry: the summary plus kept turns. */
  used: number
  /** The threshold at which older turns fold (`COMPACT_AT_TOKENS`). */
  compactAt: number
  /** How much of the way to the fold this conversation is, 0–100. */
  share: number
  /** The fold is past due: the next turn folds before answering. */
  compactsNextTurn: boolean
  /** Roughly how much recent conversation stays word for word after a fold. */
  keepRecent: number
  /** True when the message list was already folded at least once. */
  hasSummary: boolean
  /** No provider context window is stored, so no share of one is shown. */
  windowTokens: null
}

/**
 * The usage of one stored conversation. `trust` is the summary's signing
 * context, absent on a path that cannot read it, in which case the summary
 * counts as text alone rather than throwing.
 */
export function conversationUsage(
  summary: string | null,
  messages: readonly StoredMessage[],
  trust?: SummaryTrust,
): ConversationUsage {
  // The same projection the fold measures, so "near the threshold" means the
  // same historical projection as older Chat readers.
  const used = estimateTokens(promptMessages(summary, messages, trust))
  const share = COMPACT_AT_TOKENS > 0 ? Math.min(100, Math.round(used / COMPACT_AT_TOKENS * 100)) : 0
  return {
    estimated: true,
    used,
    compactAt: COMPACT_AT_TOKENS,
    share,
    compactsNextTurn: used >= COMPACT_AT_TOKENS,
    keepRecent: KEEP_RECENT_TOKENS,
    hasSummary: Boolean(summary?.trim()),
    windowTokens: null,
  }
}
