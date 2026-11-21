/*
 * What one forwarded model request used, read from the provider's own answer
 * as it streams back through the Mikka model gateway (decision 2026-11-15-2000),
 * and what it costs at the catalogue's list price. Pure: no server imports.
 */
import type { CatalogModel } from '@/lib/model-catalog'

export type GatewayProtocol = 'anthropic' | 'openai'

export interface GatewayUsage {
  inputTokens: number
  outputTokens: number
  /** Input read from the provider's prompt cache; part of `inputTokens`. */
  cacheReadTokens: number
  /** Input written to the provider's prompt cache; part of `inputTokens`. */
  cacheWriteTokens: number
}

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * Reads usage from a whole response body: an SSE stream (`data:` lines) or one
 * JSON object. Anthropic reports input on `message_start` and output on
 * `message_delta`; its `input_tokens` excludes cached input, so the total adds
 * the cache figures back. The Responses API reports everything once, on
 * `response.completed`, with cached input inside `input_tokens`. Null when the
 * answer carried no usage at all (an interrupted or failed request).
 */
function gatewayEvents(body: string): Record<string, any>[] {
  const events: unknown[] = []
  const trimmed = body.trimStart()
  if (trimmed.startsWith('{')) { try { events.push(JSON.parse(trimmed)) } catch { /* not JSON: no usage */ } }
  else for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try { events.push(JSON.parse(data)) } catch { /* a partial line: skipped */ }
  }
  return events.filter((value): value is Record<string, any> => value !== null && typeof value === 'object')
}

export function readGatewayUsage(protocol: GatewayProtocol, body: string): GatewayUsage | null {
  return readUsage(protocol, gatewayEvents(body))
}

function readUsage(protocol: GatewayProtocol, events: Record<string, any>[]): GatewayUsage | null {
  let seen = false
  const usage: GatewayUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const value of events) {
    if (protocol === 'anthropic') {
      const reported = value.type === 'message_start' ? value.message?.usage : value.type === 'message_delta' ? value.usage : value.type === 'message' ? value.usage : undefined
      if (!reported || typeof reported !== 'object') continue
      seen = true
      const read = count(reported.cache_read_input_tokens), write = count(reported.cache_creation_input_tokens)
      if ('input_tokens' in reported && count(reported.input_tokens) + read + write > 0) usage.inputTokens = count(reported.input_tokens) + read + write
      if (read) usage.cacheReadTokens = read
      if (write) usage.cacheWriteTokens = write
      if (count(reported.output_tokens)) usage.outputTokens = count(reported.output_tokens)
    } else {
      const reported = value.type === 'response.completed' || value.type === 'response.incomplete' ? value.response?.usage : value.object === 'response' ? value.usage : undefined
      if (!reported || typeof reported !== 'object') continue
      seen = true
      usage.inputTokens = count(reported.input_tokens)
      usage.outputTokens = count(reported.output_tokens)
      usage.cacheReadTokens = count(reported.input_tokens_details?.cached_tokens)
    }
  }
  return seen ? usage : null
}

export function readGatewayReceipt(protocol: GatewayProtocol, body: string) {
  const events = gatewayEvents(body)
  let messageId: string | null = null
  let cost: number | null = null
  for (const event of events) {
    const result = protocol === 'anthropic' ? (event.type === 'message_start' ? event.message : event.type === 'message' ? event : null)
      : event.object === 'response' ? event : event.response
    const id = result?.id
    if (!messageId && typeof id === 'string' && /^[\w.-]{1,200}$/.test(id)) messageId = id
    const dollars = result?.usage?.cost ?? event.usage?.cost
    if (typeof dollars === 'number' && dollars >= 0 && Number.isSafeInteger(Math.ceil(dollars * 1_000_000))) {
      cost = Math.ceil(dollars * 1_000_000)
    }
  }
  return { messageId, cost, usage: readUsage(protocol, events) }
}

/** Anthropic bills a 5-minute cache write at 1.25 times the input price. */
const CACHE_WRITE_FACTOR = 1.25

/**
 * The request's cost in micro-USD at the model's list price, with no markup
 * (decision 2026-11-15-1900). Cached input is billed at the cache-read price
 * when the catalogue has one. Null when the model has no price.
 */
export function gatewayCostMicroUsd(model: Pick<CatalogModel, 'pricing'> | undefined, usage: GatewayUsage): number | null {
  const price = model?.pricing
  if (!price) return null
  const read = Math.min(usage.cacheReadTokens, usage.inputTokens)
  const write = Math.min(usage.cacheWriteTokens, usage.inputTokens - read)
  const plain = usage.inputTokens - read - write
  // Pricing is USD per million tokens, so one token costs `price` micro-USD.
  const micro = plain * price.input + read * (price.cacheRead ?? price.input) + write * price.input * CACHE_WRITE_FACTOR + usage.outputTokens * price.output
  return Math.ceil(micro)
}
