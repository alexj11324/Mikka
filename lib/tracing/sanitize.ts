import { createHash } from 'node:crypto'
import type { Attributes, AttributeValue, Link, SpanStatus } from '@opentelemetry/api'
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base'
import { scrubString } from '@mikka/protocol/tracing'
import { telemetryId } from '@mikka/protocol/trace-context'
import { shortName } from './labels'

export { scrubString }

// The last step before a span leaves the process (docs/operations/tracing.md,
// "Privacy"). Only allowlisted attribute keys survive; SQL keeps its
// parameterized text with literals replaced; URLs lose their query strings;
// emails and IP addresses are masked; exception messages, stack traces and
// status messages (which can echo user input or SQL values) are dropped.

/** Longest SQL text kept on a span. */
export const STATEMENT_TEXT_LIMIT = 200

/** Same hash as the `statement` field of the db_sample log line (lib/db/egress-sample.ts). */
export function statementId(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** SQL text with string and number literals replaced by `?`, whitespace collapsed, cut to the limit. Placeholders ($1) stay. */
export function normalizeStatement(text: string): string {
  const normalized = text
    .replace(/(?:\b[eE])?'(?:[^']|'')*'/g, '?')
    .replace(/\$([A-Za-z_][\w]*)?\$[\s\S]*?\$\1\$/g, '?')
    .replace(/(?<![$\w."])-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > STATEMENT_TEXT_LIMIT ? `${normalized.slice(0, STATEMENT_TEXT_LIMIT - 1)}…` : normalized
}

/** First SQL keyword, upper-cased (SELECT, INSERT, BEGIN …). */
export function statementOperation(text: string): string {
  const match = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(text)
  return match ? match[1].toUpperCase() : 'UNKNOWN'
}

/** Attribute keys that may leave the process, besides any `next.*` or `mikka.*` key. */
const ALLOWED = new Set([
  'http.method', 'http.request.method', 'http.status_code', 'http.response.status_code', 'http.route', 'http.target', 'http.url', 'url.path', 'url.full',
  'net.peer.name', 'net.peer.port', 'server.port', 'error.type', 'span.kind',
  'db.system', 'db.system.name', 'db.name', 'db.namespace', 'db.operation', 'db.operation.name', 'db.response.returned_rows',
  'db.query.text', 'db.statement',
  'posthogDistinctId', 'sessionId',
])
const STATEMENT_KEYS = new Set(['db.query.text', 'db.statement'])
/** `next.*` keys that carry no request data worth the risk. */
const DROPPED_NEXT = new Set(['next.server.manifests'])

function allowed(key: string): boolean {
  if (key.startsWith('mikka.')) return true
  if (key.startsWith('next.')) return !DROPPED_NEXT.has(key)
  return ALLOWED.has(key)
}

function cleanValue(value: AttributeValue | undefined): AttributeValue | undefined {
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return undefined // arrays: none of the allowlisted keys use one
}

export function sanitizeAttributes(attributes: Attributes): Attributes {
  const clean: Attributes = {}
  for (const [key, value] of Object.entries(attributes)) {
    // Workflow uses HTTP-shaped spans for WS writes too. Keep only the
    // transport enum; socket URLs, request ids and payloads remain private.
    if (key === 'workflow.events.transport') {
      if (value === 'http' || value === 'ws') clean[key] = value
      continue
    }
    if (!allowed(key)) continue
    if (STATEMENT_KEYS.has(key)) {
      if (typeof value === 'string') clean[key] = normalizeStatement(value)
      continue
    }
    const next = cleanValue(value)
    if (next !== undefined) clean[key] = next
  }
  // PgInstrumentation 0.76 uses server.address, which must remain private.
  // Keep only a closed regional projection for the two production candidates.
  // Never trust a caller-supplied region label or export the endpoint/account.
  delete clean['mikka.db_peer_region']
  if (attributes['db.system.name'] === 'postgresql' || attributes['db.system'] === 'postgresql') {
    const host = attributes['server.address'] ?? attributes['net.peer.name']
    const region = typeof host === 'string'
      ? /^ep-[a-z0-9-]+(?:\.c-\d+)?\.(us-east-[12])\.aws\.neon\.tech$/i.exec(host)?.[1]?.toLowerCase()
      : undefined
    if (region) clean['mikka.db_peer_region'] = `aws-${region}`
  }
  // The root span learns its route only after it starts; give it the same grouping key as its children.
  if (clean['mikka.route'] === undefined && typeof clean['http.route'] === 'string') clean['mikka.route'] = clean['http.route']
  // Workflow SDK sets these after onStart. Preserve safe identifiers and
  // function labels at export, without its serialized inputs or queue payloads.
  if (telemetryId(attributes['workflow.run.id'])) clean['mikka.workflow_run_id'] = attributes['workflow.run.id'] as string
  const workflow = shortName(attributes['workflow.name'])
  const step = shortName(attributes['step.name'])
  if (workflow) clean['mikka.workflow'] = workflow
  if (step) clean['mikka.step'] = step
  return clean
}

/** SDK display names include a compiled module path; the operation is the span name. */
export function sanitizeSpanName(name: string): string {
  return scrubString(/^(?:workflow|step)\./.test(name) ? name.split(' ', 1)[0] : name)
}

function sanitizeEvent(event: TimedEvent): TimedEvent {
  const type = event.attributes?.['exception.type']
  return { name: scrubString(event.name), time: event.time, attributes: typeof type === 'string' ? { 'exception.type': scrubString(type) } : {} }
}

/**
 * A view of the span with only safe content. Everything else (ids, timing,
 * resource) is read through the original, so the exporter sees a normal span.
 */
export function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const status: SpanStatus = { code: span.status.code }
  const links: Link[] = span.links.map(link => ({ context: link.context }))
  return Object.create(span, {
    name: { value: sanitizeSpanName(span.name), enumerable: true },
    attributes: { value: sanitizeAttributes(span.attributes), enumerable: true },
    events: { value: span.events.map(sanitizeEvent), enumerable: true },
    status: { value: status, enumerable: true },
    links: { value: links, enumerable: true },
    spanContext: { value: () => span.spanContext() },
  }) as ReadableSpan
}
