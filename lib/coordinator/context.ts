import { pruneMessages, type ModelMessage } from 'ai'
import type { CoordinatorEventKind } from '@/lib/db/schema'

// What the Coordinator's model sees. Everything here depends only on the
// stored conversation, never on time or on how long the person was away, so
// the same history always becomes the same prompt.

/** Past this many tokens, older messages are folded into the summary. */
export const COMPACT_AT_TOKENS = 100_000
/** Roughly how much recent conversation stays word for word after a fold. */
export const KEEP_RECENT_TOKENS = 20_000
/** Tool calls and their results older than this many messages are dropped from the prompt. */
const KEEP_TOOL_MESSAGES = 20

export interface StoredMessage {
  position: number
  message: ModelMessage
}

/**
 * A rough token count: about four characters a token for ASCII, one for
 * anything else (Chinese text runs close to a token a character).
 */
export function estimateTokens(messages: readonly ModelMessage[]): number {
  let ascii = 0
  let other = 0
  for (const char of JSON.stringify(messages)) {
    if (char.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

/**
 * The messages sent to the model: the summary of everything folded so far,
 * then the newer messages, with old tool calls and earlier reasoning pruned.
 */
export function promptMessages(summary: string | null, messages: readonly StoredMessage[]): ModelMessage[] {
  const recent = messages.map(row => row.message)
  const head: ModelMessage[] = summary ? [{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}` }] : []
  return pruneMessages({
    messages: [...head, ...recent],
    reasoning: 'before-last-message',
    toolCalls: `before-last-${KEEP_TOOL_MESSAGES}-messages`,
    emptyMessages: 'remove',
  })
}

/**
 * The last position to fold into the summary, or null when the history still
 * fits. The cut always lands just before a user message, so a tool call is
 * never separated from its result, and keeps about `KEEP_RECENT_TOKENS` of
 * recent conversation.
 */
export function compactionCut(summary: string | null, messages: readonly StoredMessage[]): number | null {
  if (estimateTokens(promptMessages(summary, messages)) < COMPACT_AT_TOKENS) return null
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

/** Shown to the model ahead of the summary that stands in for older messages. */
export const SUMMARY_PREFIX = 'Earlier parts of this conversation were condensed into the summary below. Treat it as what you already know, and use your tools to check anything that may have changed since.'

/** Asks for the summary that replaces the folded messages. */
export const SUMMARY_INSTRUCTIONS = `You are condensing the Coordinator's conversation so it can continue with less context. Write a handoff for yourself, in the language the person writes in. Keep:
- What the person wants, their decisions and preferences, and anything they asked you to remember.
- Each run you dispatched or followed: its run id, issue, agent, and where it stands.
- Issues in play and what is still open or waiting on someone.
- What you were about to do next.
If an earlier summary is included, merge it in rather than repeating it. Be brief and concrete; leave out greetings and anything already resolved.`

/** The text the Coordinator receives for one inbox event. */
export function eventPrompt(event: { kind: CoordinatorEventKind; issueId: string | null; runId: string | null; payload: Record<string, unknown> }): string {
  const payload = event.payload
  switch (event.kind) {
    case 'user_message':
      return String(payload.text ?? '')
    case 'run_finished':
      return [
        `[Event] Run ${event.runId} ended with status ${payload.status} (${payload.stopReason}).`,
        event.issueId ? `Issue: ${event.issueId}.` : null,
        payload.summary ? `The agent's summary: ${payload.summary}` : null,
      ].filter(Boolean).join('\n')
    case 'issue_done':
      return `[Event] Issue ${event.issueId} "${payload.title}" moved from ${payload.previousStatus} to done.`
  }
}

/** Longest the memory may grow; past this the Coordinator must forget something first. */
export const MEMORY_MAX_CHARS = 8000

/** Adds one note as a Markdown list line, or null when it would not fit. */
export function rememberNote(memory: string, note: string): string | null {
  const line = `- ${note.replace(/\s+/g, ' ').trim()}`
  const next = memory ? `${memory}\n${line}` : line
  return next.length > MEMORY_MAX_CHARS ? null : next
}

/** Drops every line that contains `text`. Returns the new memory and how many lines went. */
export function forgetNotes(memory: string, text: string): { memory: string; removed: number } {
  const needle = text.trim().toLowerCase()
  const lines = memory ? memory.split('\n') : []
  const kept = needle ? lines.filter(line => !line.toLowerCase().includes(needle)) : lines
  return { memory: kept.join('\n'), removed: lines.length - kept.length }
}

/** The system prompt with the person's memory after it. */
export function instructionsWithMemory(instructions: string, memory: string): string {
  if (!memory) return instructions
  return `${instructions}\n\n## What the person asked you to remember\n${memory}`
}
