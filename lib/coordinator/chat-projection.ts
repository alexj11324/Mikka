import { sql, type SQL } from 'drizzle-orm'
import { coordinatorMessages } from '@/lib/db/schema'
import { QUOTE_KEYS, QUOTE_PREVIEW_CHARS, QUOTE_SPACE } from './context'

/** Characters of a tool's input or output a chat summary keeps. */
export const TOOL_PREVIEW_CHARS = 200

/** Tool results whose `{ runId }` the chat reads to show the dispatched thread (context.ts `dispatchedRun`). */
const DISPATCH_TOOLS = ['dispatch_run', 'dispatch_bot_computer'] as const

/**
 * The compact form of a stored message's parts that the chat reads (stable
 * shape; UI builds on it):
 * - `{ type: 'reasoning', chars }`: how long the model's thinking was, never its text.
 * - `{ type: 'tool-call', toolCallId, toolName, inputPreview }`: the input as JSON text, first 200 characters.
 * - `{ type: 'tool-result', toolCallId, toolName, status: 'done' | 'error', outputPreview, output? }`:
 *   the output's value as text, first 200 characters; `output` is kept only as
 *   `{ type: 'json', value: { runId } }` for the dispatch tools.
 * - `{ type: 'file', mediaType }`: without its data.
 * Text parts and the message's own fields (role, mikka*) are unchanged.
 * Stored messages are masked before they are saved (store.ts), so previews only shorten masked text.
 */
export type CompactReasoningPart = { type: 'reasoning'; chars: number }
export type CompactToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; inputPreview?: string; quotePreview?: string }
export type CompactToolResultPart = {
  type: 'tool-result'; toolCallId: string; toolName: string; status: 'done' | 'error'; outputPreview?: string
  output?: { type: 'json'; value: { runId?: string } }
}

const dispatchTools = sql.raw(DISPATCH_TOOLS.map(name => `'${name}'`).join(','))
const preview = sql.raw(String(TOOL_PREVIEW_CHARS))
// A call's words (a dispatch's note) apart from its cut input preview; one character over so the chat can mark the cut.
// Only string fields, trimmed of the same whitespace as quoteText (btrim would leave newlines and tabs).
const quoteFields = sql.raw(QUOTE_KEYS.map(key => `case when jsonb_typeof(p#>'{input,${key}}') = 'string' then nullif(regexp_replace(p#>>'{input,${key}}', '^[${QUOTE_SPACE}]+|[${QUOTE_SPACE}]+$', '', 'g'), '') end`).join(', '))
const quoteChars = sql.raw(String(QUOTE_PREVIEW_CHARS + 1))

/**
 * `coordinator_messages.message` with reasoning text, tool inputs and tool
 * outputs reduced to the compact parts above, computed in the database so the
 * full JSON never leaves it. The chat only shows text, tool names, dispatched
 * threads and image counts; a chat with long thinking or large tool results
 * otherwise sent hundreds of kilobytes on every poll.
 */
export const compactChatMessage: SQL<Record<string, unknown>> = sql`case when jsonb_typeof(${coordinatorMessages.message}->'content') = 'array'
  then jsonb_set(${coordinatorMessages.message}, '{content}', coalesce((
    select jsonb_agg(case p->>'type'
      when 'reasoning' then jsonb_build_object('type', 'reasoning', 'chars', char_length(coalesce(p->>'text', '')))
      when 'tool-call' then jsonb_strip_nulls(jsonb_build_object('type', 'tool-call', 'toolCallId', p->'toolCallId', 'toolName', p->'toolName',
        'inputPreview', left(p->>'input', ${preview}),
        'quotePreview', left(coalesce(${quoteFields}), ${quoteChars})))
      when 'tool-result' then jsonb_strip_nulls(jsonb_build_object('type', 'tool-result', 'toolCallId', p->'toolCallId', 'toolName', p->'toolName',
        'status', case when p#>>'{output,type}' like 'error%' then 'error' else 'done' end,
        'outputPreview', left(p#>>'{output,value}', ${preview}),
        'output', case when p->>'toolName' in (${dispatchTools}) and p#>>'{output,type}' = 'json'
          then jsonb_build_object('type', 'json', 'value', jsonb_strip_nulls(jsonb_build_object('runId', p#>'{output,value,runId}'))) end))
      when 'file' then jsonb_strip_nulls(jsonb_build_object('type', 'file', 'mediaType', p->'mediaType'))
      else p end order by ord)
    from jsonb_array_elements(${coordinatorMessages.message}->'content') with ordinality as part(p, ord)), '[]'::jsonb))
  else ${coordinatorMessages.message} end`
