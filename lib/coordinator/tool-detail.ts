// What an opened tool call says before its raw data (R-83): who it went to, what it was asked, what came back, as
// lines a person reads. Ids are never shown; the raw input and output stay one more click away. Pure, for tests.
import { QUOTE_KEYS, quotePreview, type ChatTool } from '@/lib/coordinator/context'
import { toolAction } from '@/lib/coordinator/tool-activity'

export type ToolDetailLine =
  /** Who a dispatch went to: its thread (drawn as its chip when loaded), the coding agent, and the answer's status. */
  | { kind: 'handoff'; runId: string | null; harness: string | null; status: string | null }
  /** What the call was asked to do, in the person's or model's words: a quote, three lines until opened. */
  | { kind: 'quote'; text: string }
  /** A task or thread the call acted on or made, drawn as its chip. */
  | { kind: 'object'; id: string }
  /** A named value: a search, a count, a state. `label` is a message key under `Coordinator.activity.detail`. */
  | { kind: 'field'; label: string; value: string | number }
  /** An unregistered tool's own field, as it named it. */
  | { kind: 'pair'; key: string; value: string }

/** An id's key, in any casing a tool uses: id, ID, runId, runID, run_id, ids, uuid. */
const ID_KEY = /^(?:id|ID|Id|uuid|UUID)s?$|(?:Id|ID|_id|_ID|Uuid|UUID|_uuid)s?$/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const WHOLE_UUID = new RegExp(`^${UUID.source}$`, 'i')
const UUIDS = new RegExp(UUID.source, 'gi')
/** An opaque id a tool returns besides UUIDs: `b_9f8e7d`, `toolu_01AbC…`, `dispatch:toolu_…` (a prefix, then letters with a digit). */
const OPAQUE_ID = /\b[a-z]{1,12}_(?=[0-9a-z]*\d)[0-9a-z]{6,}\b/i
const OPAQUE_IDS = new RegExp(OPAQUE_ID.source, 'gi')
const MAX_PAIRS = 6
const MAX_VALUE = 80

/** Text with every id in it replaced by an ellipsis, so a quote never shows one. */
export function withoutIds(text: string): string {
  return text.replace(UUIDS, '…').replace(OPAQUE_IDS, '…')
}

/**
 * A preview's top-level fields. A preview is cut at 200 characters, so when it is not whole JSON its leading
 * `"key": value` pairs are read one by one; a string cut short is read as what arrived plus an ellipsis, and ends the read.
 */
export function previewFields(text: string | undefined): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : Array.isArray(parsed) ? { items: parsed } : {}
  } catch { /* cut short: read what is whole */ }
  const fields: Record<string, unknown> = {}
  const pair = /"([^"\\]+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*[,}]/y
  pair.lastIndex = text.indexOf('{') + 1
  if (pair.lastIndex === 0) return fields
  let at = pair.lastIndex
  for (let match = pair.exec(text); match; match = pair.exec(text)) {
    fields[match[1]] = JSON.parse(match[2]) as unknown
    while (pair.lastIndex < text.length && /\s/.test(text[pair.lastIndex])) pair.lastIndex++
    at = pair.lastIndex
  }
  // The cut fell inside a string value: keep what arrived of it.
  const tail = /"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)\\?$/y
  tail.lastIndex = at
  const cut = tail.exec(text)
  if (cut) {
    const partial = cut[2].replace(/\\u[0-9a-fA-F]{0,3}$/, '')
    try { fields[cut[1]] = `${(JSON.parse(`"${partial}"`) as string).trimEnd()}…` } catch { /* an escape cut in half: leave it out */ }
  }
  return fields
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
const firstText = (fields: Record<string, unknown>, keys: readonly string[]) => keys.map(key => text(fields[key])).find(Boolean) ?? null
const id = (fields: Record<string, unknown>, keys: readonly string[]) => keys.map(key => text(fields[key])).find(value => value && WHOLE_UUID.test(value)) ?? null
const count = (fields: Record<string, unknown>, keys: readonly string[]) => keys.map(key => fields[key]).find(Array.isArray)?.length ?? null
/** A field's text unless it holds an id. */
const plain = (value: string | null) => value && !UUID.test(value) && !OPAQUE_ID.test(value) ? value : null

/** An unregistered tool's fields as `key: value`: no ids, no nested objects, each value cut short, at most six in all. */
function pairs(...sources: Record<string, unknown>[]): ToolDetailLine[] {
  const lines: ToolDetailLine[] = []
  for (const [key, value] of sources.flatMap(fields => Object.entries(fields))) {
    if (lines.length === MAX_PAIRS) break
    if (ID_KEY.test(key) || value === null || value === undefined || typeof value === 'object') continue
    const shown = String(value).replace(/\s+/g, ' ').trim()
    if (!shown || UUID.test(shown) || OPAQUE_ID.test(shown)) continue
    lines.push({ kind: 'pair', key, value: shown.length > MAX_VALUE ? `${shown.slice(0, MAX_VALUE - 1)}…` : shown })
  }
  return lines
}

/**
 * What an opened call shows before its raw data, from its input, output and quote; empty when there is nothing to
 * say. A failed call says nothing here: its row already names the reason, and what it was asked never happened.
 */
export function toolDetail(tool: Pick<ChatTool, 'name' | 'input' | 'output' | 'quote'>, failed = false): ToolDetailLine[] {
  if (failed) return []
  const input = previewFields(tool.input), output = previewFields(tool.output)
  const lines: ToolDetailLine[] = []
  const quote = (value: string | null | undefined) => { const shown = value ? withoutIds(value).trim() : ''; if (shown && shown !== '…') lines.push({ kind: 'quote', text: shown }) }
  const words = () => tool.quote ?? quotePreview(firstText(input, QUOTE_KEYS))
  const object = (value: string | null) => { if (value && !lines.some(line => line.kind === 'object' && line.id === value)) lines.push({ kind: 'object', id: value }) }
  const field = (label: string, value: string | number | null) => { if (value !== null && value !== '') lines.push({ kind: 'field', label, value }) }
  switch (toolAction(tool.name)) {
    case 'dispatch':
    case 'dispatchFactory':
    case 'wake':
      // Who it went to and the thread it made first, its note under them. The task gets no chip: the thread's
      // carries it (R-15).
      lines.push({ kind: 'handoff', runId: id(output, ['runId', 'threadId', 'thread']) ?? id(input, ['runId']),
        harness: firstText(output, ['harness']) ?? firstText(input, ['harness']), status: firstText(output, ['status']) })
      quote(words())
      break
    case 'messageThread':
    case 'stopThread':
      object(id(input, ['runId', 'threadId']))
      quote(tool.quote ?? firstText(input, ['message', 'text', 'note', 'reason']))
      break
    case 'createIssue':
    case 'updateIssue':
      object(id(output, ['id', 'issueId']) ?? id(input, ['issueId', 'id']))
      field('title', plain(firstText(input, ['title'])))
      field('status', plain(firstText(input, ['status'])))
      break
    case 'viewIssues':
    case 'viewThreads':
      object(id(input, ['runId', 'issueId', 'id']))
      field('query', plain(firstText(input, ['query', 'q', 'identifier'])))
      field('count', count(output, ['items', 'issues', 'runs', 'threads', 'results']))
      break
    case 'searchWeb':
    case 'readMail':
    case 'readSlack':
    case 'readNotion':
    case 'viewCalendar':
    case 'viewDrive':
    case 'findRepository':
      field('query', plain(firstText(input, ['query', 'q', 'search', 'repository', 'repo', 'name'])))
      field('count', count(output, ['results', 'items', 'messages', 'pages', 'events', 'files', 'repositories']))
      field('repository', plain(firstText(output, ['repository', 'fullName'])))
      break
    case 'readWeb':
      field('page', plain(firstText(input, ['url', 'task'])))
      break
    case 'sendMail':
    case 'sendSlack':
      field('to', plain(firstText(input, ['to', 'channel', 'recipient'])))
      field('subject', plain(firstText(input, ['subject'])))
      quote(words())
      break
    case 'remember':
    case 'forget':
      quote(tool.quote ?? firstText(input, ['text', 'memory', 'content', 'fact']))
      break
    default:
      lines.push(...pairs(input, output))
  }
  return lines
}
