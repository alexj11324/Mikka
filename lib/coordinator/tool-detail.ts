// What an opened tool call says before its raw data (R-83): who it went to, what it was asked, what came back, as
// lines a person reads. Ids are never shown; the raw input and output stay one more click away. Pure, for tests.
import type { ChatTool } from '@/lib/coordinator/context'
import { toolAction } from '@/lib/coordinator/tool-activity'

export type ToolDetailLine =
  /** What the call was asked to do, in the person's or model's words: a quote, three lines until opened. */
  | { kind: 'quote'; text: string }
  /** A task or thread the call acted on or made, drawn as its chip; a thread also shows its state. */
  | { kind: 'object'; id: string }
  /** A named value: a search, a count, a state. `label` is a message key under `Coordinator.activity.detail`. */
  | { kind: 'field'; label: string; value: string | number }
  /** An unregistered tool's own field, as it named it. */
  | { kind: 'pair'; key: string; value: string }

const ID_KEY = /(?:^id$|Id$|_id$|^uuid$)/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAIRS = 6
const MAX_VALUE = 80

/**
 * A preview's top-level fields. A preview is cut at 200 characters, so when it is not whole JSON its leading
 * `"key": value` pairs are read one by one; a value cut short ends the read.
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
  for (let match = pair.exec(text); match; match = pair.exec(text)) {
    fields[match[1]] = JSON.parse(match[2]) as unknown
    while (pair.lastIndex < text.length && /\s/.test(text[pair.lastIndex])) pair.lastIndex++
  }
  return fields
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
const firstText = (fields: Record<string, unknown>, keys: readonly string[]) => keys.map(key => text(fields[key])).find(Boolean) ?? null
const id = (fields: Record<string, unknown>, keys: readonly string[]) => keys.map(key => text(fields[key])).find(value => value && UUID.test(value)) ?? null
const count = (fields: Record<string, unknown>, keys: readonly string[]) => keys.map(key => fields[key]).find(Array.isArray)?.length ?? null

/** An unregistered tool's fields as `key: value`: no ids, no nested objects, each value cut short, at most six. */
function pairs(fields: Record<string, unknown>): ToolDetailLine[] {
  const lines: ToolDetailLine[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (lines.length === MAX_PAIRS) break
    if (ID_KEY.test(key) || value === null || value === undefined || typeof value === 'object') continue
    const shown = String(value).replace(/\s+/g, ' ').trim()
    if (!shown || UUID.test(shown)) continue
    lines.push({ kind: 'pair', key, value: shown.length > MAX_VALUE ? `${shown.slice(0, MAX_VALUE - 1)}…` : shown })
  }
  return lines
}

/** What an opened call shows before its raw data, from its input and output; empty when there is nothing to say. */
export function toolDetail(tool: Pick<ChatTool, 'name' | 'input' | 'output'>): ToolDetailLine[] {
  const input = previewFields(tool.input), output = previewFields(tool.output)
  const lines: ToolDetailLine[] = []
  const quote = (value: string | null) => { if (value) lines.push({ kind: 'quote', text: value }) }
  const object = (value: string | null) => { if (value && !lines.some(line => line.kind === 'object' && line.id === value)) lines.push({ kind: 'object', id: value }) }
  const field = (label: string, value: string | number | null) => { if (value !== null && value !== '') lines.push({ kind: 'field', label, value }) }
  switch (toolAction(tool.name)) {
    case 'dispatch':
    case 'dispatchFactory':
    case 'wake':
      quote(firstText(input, ['note', 'prompt', 'instruction', 'message', 'request', 'text']))
      object(id(output, ['runId', 'threadId', 'thread']) ?? id(input, ['runId']))
      // The thread's chip carries its state; without a thread the answer's own status is all there is.
      if (!lines.some(line => line.kind === 'object')) field('status', firstText(output, ['status']))
      object(id(output, ['issueId', 'taskId']) ?? id(input, ['issueId', 'taskId']))
      break
    case 'messageThread':
    case 'stopThread':
      object(id(input, ['runId', 'threadId']))
      quote(firstText(input, ['message', 'text', 'note', 'reason']))
      break
    case 'createIssue':
    case 'updateIssue':
      object(id(output, ['id', 'issueId']) ?? id(input, ['issueId', 'id']))
      field('title', firstText(input, ['title']))
      field('status', firstText(input, ['status']))
      break
    case 'viewIssues':
    case 'viewThreads':
      object(id(input, ['runId', 'issueId', 'id']))
      field('query', firstText(input, ['query', 'q', 'identifier']))
      field('count', count(output, ['items', 'issues', 'runs', 'threads', 'results']))
      break
    case 'searchWeb':
    case 'readMail':
    case 'readSlack':
    case 'readNotion':
    case 'viewCalendar':
    case 'viewDrive':
    case 'findRepository':
      field('query', firstText(input, ['query', 'q', 'search', 'repository', 'repo', 'name']))
      field('count', count(output, ['results', 'items', 'messages', 'pages', 'events', 'files', 'repositories']))
      field('repository', firstText(output, ['repository', 'fullName']))
      break
    case 'readWeb':
      field('page', firstText(input, ['url', 'task']))
      break
    case 'sendMail':
    case 'sendSlack':
      field('to', firstText(input, ['to', 'channel', 'recipient']))
      field('subject', firstText(input, ['subject']))
      quote(firstText(input, ['text', 'body', 'message']))
      break
    case 'remember':
    case 'forget':
      quote(firstText(input, ['text', 'memory', 'content', 'fact']))
      break
    default:
      lines.push(...pairs(input), ...pairs(output))
  }
  return lines
}
