import { pruneMessages, type ModelMessage } from 'ai'
import { COORDINATOR_WELCOME_MARK } from '@/lib/agent-welcome'
import type { CoordinatorEventKind, CoordinatorEventTier } from '@/lib/db/schema'
import { splitQuote, type ArtifactQuote } from '@/lib/artifacts/quote'

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
  /** coordinator_messages.id for persisted rows; absent for pending inbox items. */
  id?: string
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
export function eventPrompt(event: { kind: CoordinatorEventKind; issueId: string | null; runId: string | null; payload: Record<string, unknown>; tier?: CoordinatorEventTier | null }): string {
  const payload = event.payload
  const note = event.tier === 'attention' ? 'Triage: this needs the person; tell them.' : event.tier === 'background' ? 'Triage: background; mention it only if it matters to what you are doing.' : null
  switch (event.kind) {
    case 'user_message':
      return [event.issueId ? 'This chat is linked to issue ' + event.issueId + '.' : null, String(payload.text ?? '')].filter(Boolean).join('\n\n')
    case 'run_finished':
      return [
        `[Event] Run ${event.runId} ended with status ${payload.status} (${payload.stopReason}).`,
        event.issueId ? `Issue: ${event.issueId}.` : null,
        payload.summary ? `The agent's summary: ${payload.summary}` : null,
        note,
      ].filter(Boolean).join('\n')
    case 'run_retried':
      return [
        `[Event] Run ${event.runId} lost its machine (the device went offline), so it was ${payload.movedToDeviceId ? `handed to device ${payload.movedToDeviceId}` : 'queued again'} as run ${payload.retryRunId}, attempt ${payload.attempt} of ${payload.maxAttempts}.`,
        event.issueId ? `Issue: ${event.issueId}.` : null,
        'Nothing to do; follow the new run.',
        note,
      ].filter(Boolean).join('\n')
    case 'issue_done':
      return [`[Event] Issue ${event.issueId} "${payload.title}" moved from ${payload.previousStatus} to done.`, note].filter(Boolean).join('\n')
    case 'run_report':
      return [`[Event] The agent in run ${event.runId} reports progress: ${payload.text}`, event.issueId ? `Issue: ${event.issueId}.` : null, note].filter(Boolean).join('\n')
    case 'run_question':
      return [
        `[Event] The agent in run ${event.runId} asks the person: ${payload.question}`,
        Array.isArray(payload.options) ? `Options: ${payload.options.join(' / ')}` : null,
        payload.context ? `Context: ${payload.context}` : null,
        'The run keeps going. Ask the person, then pass their answer on with send_to_run.',
        note,
      ].filter(Boolean).join('\n')
    case 'artifact_submitted':
      return [
        `[Event] ${payload.authorName}${event.runId ? ` (run ${event.runId})` : ''} handed over ${payload.artifactKind === 'html' ? 'a web page' : 'a document'} "${payload.title}", version ${payload.version}: [[artifact:${payload.artifactId}]]`,
        event.issueId ? `Issue: ${event.issueId}.` : null,
        'The person sees it as a card under your next reply. Say in a sentence what it is; do not repeat its content.',
        note,
      ].filter(Boolean).join('\n')
    case 'action_decided': {
      const what = `${payload.action} (proposal ${payload.actionId})`
      const outcome = payload.outcome && typeof payload.outcome === 'object' && Object.keys(payload.outcome).length ? ` Result: ${JSON.stringify(payload.outcome)}.` : ''
      return [
        payload.status === 'done' ? `[Event] The person approved ${what} and it is done.${outcome}`
          : payload.status === 'failed' ? `[Event] The person approved ${what} but it failed: ${payload.error}.`
          : `[Event] The person declined ${what}. It did not happen.`,
        `What it was: ${JSON.stringify(payload.input).slice(0, 2000)}`,
        note,
      ].filter(Boolean).join('\n')
    }
    case 'run_blocked':
      return [
        `[Event] The agent in run ${event.runId} is blocked: ${payload.reason}`,
        'Tell the person what it needs. Pass their answer on with send_to_run, or stop_run if they say so.',
        note,
      ].filter(Boolean).join('\n')
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

/** One entry in the chat the person sees. */
export interface ChatItem {
  /** coordinator_messages.id of the row this item starts at; absent while the message is still pending in the inbox. */
  id?: string
  position: number
  from: 'person' | 'coordinator' | 'event'
  text: string
  /** Tools the Coordinator used for this reply, in order. */
  tools: string[]
  /** Runs this reply dispatched, each shown once as a thread card under it (R-66). */
  threads: string[]
  createdAt: string
  /** Still in the inbox: its position is inferred, not a coordinator_messages row, so it can't be marked read. */
  pending?: true
  /** What the person quoted from an artifact, shown above their text. */
  quote?: ArtifactQuote
  /** Artifacts shown as cards under this entry, in order. */
  artifacts: string[]
}

/** The run id a successful local or Bot-computer dispatch carries. */
function dispatchedRun(part: { type: string; toolName?: string; output?: unknown }): string | null {
  if (part.type !== 'tool-result' || (part.toolName !== 'dispatch_run' && part.toolName !== 'dispatch_bot_computer')) return null
  const output = part.output as { type?: string; value?: unknown } | undefined
  const value = output?.type === 'json' ? output.value : null
  const runId = value && typeof value === 'object' ? (value as { runId?: unknown }).runId : null
  return typeof runId === 'string' ? runId : null
}

const ARTIFACT_CITATION = /\[\[artifact:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/gi

/** The artifact ids cited in `text`, and the text without those citations. */
function takeArtifacts(text: string): { ids: string[]; text: string } {
  const ids = [...text.matchAll(ARTIFACT_CITATION)].map(match => match[1].toLowerCase())
  return { ids, text: ids.length ? text.replace(ARTIFACT_CITATION, '').replace(/[ \t]+\n/g, '\n').trim() : text }
}

/**
 * The conversation as the person sees it: their messages, Mikka's events, and
 * one entry per Coordinator reply, with the tools it called folded in. An
 * artifact the Coordinator was told about shows as a card under its next
 * reply (or on its own when no reply came yet) instead of as an event line;
 * one the reply cites goes there too, once.
 */
export function chatItems(rows: readonly (StoredMessage & { createdAt: Date; pending?: true })[]): ChatItem[] {
  const items: ChatItem[] = []
  // Artifacts handed over since the last reply, waiting for one to sit under.
  const waiting = { ids: [] as string[], position: 0, createdAt: new Date(0) }
  const flush = () => {
    if (!waiting.ids.length) return
    items.push({ position: waiting.position, from: 'coordinator', text: '', tools: [], threads: [], createdAt: waiting.createdAt.toISOString(), artifacts: [...new Set(waiting.ids)] })
    waiting.ids = []
  }
  for (const { id, position, message, createdAt, pending } of rows) {
    if (message.role === 'user') {
      const raw = typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      // The request for its welcome is for the Coordinator only.
      if (raw.startsWith(COORDINATOR_WELCOME_MARK)) continue
      const event = raw.startsWith('[Event]')
      if (event) {
        const cited = takeArtifacts(raw.split('\n')[0])
        if (cited.ids.length) {
          Object.assign(waiting, { ids: [...waiting.ids, ...cited.ids], position, createdAt })
          continue
        }
      }
      flush()
      const base = { ...(id ? { id } : {}), position, tools: [], threads: [], createdAt: createdAt.toISOString(), artifacts: [], ...(pending ? { pending } : {}) }
      // The triage line is for the Coordinator, not the person.
      if (event) items.push({ ...base, from: 'event', text: raw.split('\n').filter(line => !line.startsWith('Triage:')).join('\n') })
      else {
        const { quote, text } = splitQuote(raw)
        items.push({ ...base, from: 'person', text, ...(quote ? { quote } : {}) })
      }
    } else if (message.role === 'assistant') {
      const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
      const cited = takeArtifacts(parts.flatMap(part => part.type === 'text' && part.text.trim() ? [part.text.trim()] : []).join('\n\n'))
      const tools = parts.flatMap(part => part.type === 'tool-call' ? [part.toolName] : [])
      const last = items.at(-1)
      const shown = [...waiting.ids, ...cited.ids]
      if (last?.from === 'coordinator' && !waiting.ids.length) {
        last.text = [last.text, cited.text].filter(Boolean).join('\n\n')
        last.tools.push(...tools)
        last.artifacts = [...new Set([...last.artifacts, ...cited.ids])]
      } else if (cited.text || tools.length || shown.length) {
        items.push({ ...(id ? { id } : {}), position, from: 'coordinator', text: cited.text, tools, threads: [], createdAt: createdAt.toISOString(), artifacts: [...new Set(shown)] })
        waiting.ids = []
      }
    } else if (message.role === 'tool') {
      const last = items.at(-1)
      if (last?.from !== 'coordinator') continue
      for (const part of message.content) {
        const runId = dispatchedRun(part)
        if (runId && !last.threads.includes(runId)) last.threads.push(runId)
      }
    }
  }
  flush()
  return items
}
