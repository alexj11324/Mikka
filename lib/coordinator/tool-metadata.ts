import type { ToolSet } from 'ai'

/** UI metadata only. Never changes a tool's inputs, execution, result or authority. */
export const TOOL_TARGET_CHARS = 160
export const TOOL_DISPLAY_NAME_CHARS = 128
export const TOOL_OPERATION_CHARS = 128
export const TOOL_IDENTIFIER_SOURCE = '[A-Za-z][A-Za-z0-9_.:-]{0,127}'
export const TOOL_IDENTIFIER_PATTERN = '^' + TOOL_IDENTIFIER_SOURCE + '$'
export const TOOL_ERROR_TEXT_PATTERN = '^(' + TOOL_IDENTIFIER_SOURCE + ')(?: \\((' + TOOL_IDENTIFIER_SOURCE + ')\\))?$'
/** Shared with the JSONB projection; only these string fields leave a full input as a target. */
export const TOOL_TARGET_KEYS = ['identifier', 'title', 'name', 'query', 'q', 'subject', 'repository', 'repo', 'url', 'path', 'operation', 'text', 'message', 'instruction', 'toolkit'] as const
export const DYNAMIC_TOOL_NAMES = {
  github_call: { field: 'name', prefix: 'GitHub' },
  call_personal_mcp_tool: { field: 'name', prefix: 'MCP' },
  call_app_tool: { field: 'tool', prefix: '' },
} as const
export const TOOL_SPACE = ' \\t\\n\\r\\f\\v'
const SPACE = /[ \t\n\r\f\v]+/g
const IDENTIFIER = new RegExp(TOOL_IDENTIFIER_PATTERN)
const ERROR_TEXT = new RegExp(TOOL_ERROR_TEXT_PATTERN)

export type ToolCallMetadata = { displayName: string; target?: string }
export type ToolResultMetadata = { state: 'done' | 'error'; errorCode?: string; errorDetail?: string }
export type ProjectedToolMetadata = { target?: unknown; operationName?: unknown; errorCode?: unknown; errorDetail?: unknown }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function words(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(SPACE, ' ').replace(/^ | $/g, '') || undefined : undefined
}
function rawWords(value: unknown): string | undefined {
  return typeof value === 'string' && words(value) ? value : undefined
}
/** Code-point bounds match PostgreSQL left()/char_length(), including emoji. */
export function toolLabel(value: unknown, limit: number): string | undefined {
  const text = words(value)
  if (!text) return undefined
  const chars = Array.from(text)
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text
}
export function toolIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.exec(value)?.[0] === value ? value : undefined
}
const BRAND_WORDS: Record<string, string> = { api: 'API', github: 'GitHub', gmail: 'Gmail', mcp: 'MCP', notion: 'Notion', slack: 'Slack', url: 'URL', id: 'ID', pr: 'PR' }
export function readableToolName(name: string): string {
  const text = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  const value = (words(text) ?? name).split(' ').map((part, index) => {
    const lower = part.toLowerCase()
    return BRAND_WORDS[lower] ?? (index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower)
  }).join(' ')
  return toolLabel(value, TOOL_DISPLAY_NAME_CHARS) ?? name
}
function dynamic(name: string): { field: string; prefix: string } | undefined {
  return Object.hasOwn(DYNAMIC_TOOL_NAMES, name) ? DYNAMIC_TOOL_NAMES[name as keyof typeof DYNAMIC_TOOL_NAMES] : undefined
}
/** Kept whole for the live stream's secret check before shortening or humanizing. */
export function rawToolOperation(name: string, input: unknown): string | undefined {
  const entry = dynamic(name)
  return entry ? rawWords(record(input)?.[entry.field]) : undefined
}
export function toolDisplayName(name: string, operation?: unknown): string {
  const entry = dynamic(name), called = words(operation)
  if (!entry || !called) return readableToolName(name)
  const title = readableToolName(Array.from(called).slice(0, TOOL_OPERATION_CHARS).join(''))
  return toolLabel(entry.prefix ? entry.prefix + ' · ' + title : title, TOOL_DISPLAY_NAME_CHARS)!
}
/** No lookup: an id-only input remains id-only; it does not invent a title. */
export function rawToolTarget(name: string, input: unknown): string | undefined {
  const root = record(input)
  const args = dynamic(name) ? record(root?.arguments) : root
  if (!args) return undefined
  for (const key of TOOL_TARGET_KEYS) {
    const value = rawWords(args[key])
    if (value) return key === 'repo' && rawWords(args.owner) ? rawWords(args.owner)! + '/' + value : value
  }
  return undefined
}
export function toolCallMetadata(name: string, input: unknown, projected: ProjectedToolMetadata = {}): ToolCallMetadata {
  const target = toolLabel(input === undefined ? projected.target : rawToolTarget(name, input), TOOL_TARGET_CHARS)
  return { displayName: toolDisplayName(name, input === undefined ? projected.operationName : rawToolOperation(name, input)), ...(target ? { target } : {}) }
}
function errorText(value: unknown): { code: string; detail?: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = ERROR_TEXT.exec(value)
  return match?.[0] === value ? { code: match[1], ...(match[2] ? { detail: match[2] } : {}) } : undefined
}
/** Only the receipt's own failure markers count; errors in listed data are not this call's failure. */
export function toolResultMetadata(value: unknown, forcedError = false): ToolResultMetadata {
  const top = record(value)
  const failed = forcedError || Boolean(top && (
    (Object.hasOwn(top, 'error') && top.error !== undefined && top.error !== null && top.error !== false && top.error !== '') ||
    top.ok === false || top.isError === true))
  if (!failed) return { state: 'done' }
  const nested = record(top?.error)
  const structured = top?.isError === true ? record(top.structuredContent) : undefined
  const structuredError = record(structured?.error)
  const code = [top?.errorCode, nested?.code, top?.error, top?.code, top?.reason,
    structured?.errorCode, structuredError?.code, structured?.error, structured?.code, structured?.reason,
    top?.message, value].map(errorText).find(Boolean)
  const detail = [nested?.detail, top?.detail, nested?.reason, top?.reason,
    structuredError?.detail, structured?.detail, structuredError?.reason, structured?.reason, code?.detail]
    .map(toolIdentifier).find(item => item !== undefined && item !== code?.code)
  // A legacy/provider receipt with no code stays failed; never invent a generic code or a missing reason.
  return { state: 'error', ...(code ? { errorCode: code.code } : {}), ...(detail ? { errorDetail: detail } : {}) }
}
export function projectedToolResult(status: unknown, metadata: ProjectedToolMetadata): ToolResultMetadata {
  if (status !== 'error') return { state: 'done' }
  const errorCode = toolIdentifier(metadata.errorCode), errorDetail = toolIdentifier(metadata.errorDetail)
  return { state: 'error', ...(errorCode ? { errorCode } : {}), ...(errorDetail ? { errorDetail } : {}) }
}
export function withToolDisplayNames(registry: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(registry).map(([name, definition]) => [name, { ...definition, displayName: toolDisplayName(name) }]))
}
/** Display text from an already redacted catalogue. Descriptions and schemas remain untrusted data. */
export function catalogueToolDisplayName(entry: { name: string; title?: unknown; annotations?: unknown }): string {
  return toolLabel(entry.title, TOOL_DISPLAY_NAME_CHARS) ?? toolLabel(record(entry.annotations)?.title, TOOL_DISPLAY_NAME_CHARS) ?? readableToolName(entry.name)
}
