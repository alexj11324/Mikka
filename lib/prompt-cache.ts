import type { LanguageModel, SystemModelMessage } from 'ai'

/**
 * Prompt caching for the Coordinator's model calls.
 *
 * A provider caches a request's prefix: tools, then system, then messages. The
 * system prompt separates rules (including the card catalog and personal
 * instructions), repository/model context, and the changing memory/live tail.
 * The first two have their own breakpoints, so changes to the repository list
 * do not invalidate the earlier tools and rules. The last conversation message
 * also has a breakpoint for calls that share the same history.
 *
 * Claude needs explicit breakpoints (OpenAI and DeepSeek cache prefixes on
 * their own); a breakpoint is an `ephemeral` cache_control, at most four per
 * request, and the layered prompt uses three. Old persisted prompts with a
 * single stable boundary retain their two-breakpoint layout.
 */

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type Prompt = Parameters<V4Model['doStream']>[0]['prompt']
type Message = Prompt[number]

/** The system prompt as one message, or split where its stable prefix ends. Pure: runs in the Workflow body. */
export function cacheableInstructions(text: string, stable?: number, stableRules?: number): string | SystemModelMessage[] {
  if (typeof stableRules === 'number' && typeof stable === 'number' && Number.isInteger(stableRules) && Number.isInteger(stable) && stableRules > 0 && stableRules <= stable && stable <= text.length) {
    const messages: SystemModelMessage[] = []
    let start = 0
    for (const end of new Set([stableRules, stable])) {
      messages.push({ role: 'system', content: text.slice(start, end), providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } })
      start = end
    }
    if (start < text.length) messages.push({ role: 'system', content: text.slice(start) })
    return messages
  }
  if (!stable || stable <= 0 || stable >= text.length) return text
  return [{ role: 'system', content: text.slice(0, stable) }, { role: 'system', content: text.slice(stable) }]
}

/** Boundaries become system messages, never options of WorkflowAgent itself. */
export function promptOptions<T extends { instructions?: string; stable?: number; stableRules?: number }>({ instructions, stable, stableRules, ...rest }: T): Omit<T, 'instructions' | 'stable' | 'stableRules'> & { instructions?: string | SystemModelMessage[] } {
  return instructions === undefined ? rest : { ...rest, instructions: cacheableInstructions(instructions, stable, stableRules) }
}

/**
 * Marks the first system, explicitly cacheable system layers, and last message.
 * `openaiCompatible` is the key Mikka's Claude subscription transport reads
 * (the broker turns it into Anthropic cache_control); `anthropic` is the AI
 * SDK's own Anthropic option. The last message is also marked on its last
 * part, where a single-text user message or a tool result carries it.
 */
export function withCacheBreakpoints(prompt: Prompt, key: 'openaiCompatible' | 'anthropic'): Prompt {
  const marker = key === 'anthropic' ? { cacheControl: { type: 'ephemeral' } } : { cache_control: { type: 'ephemeral' } }
  const mark = <M extends { providerOptions?: Record<string, Record<string, unknown>> }>(item: M): M =>
    ({ ...item, providerOptions: { ...item.providerOptions, [key]: { ...item.providerOptions?.[key], ...marker } } }) as M
  const system = prompt.findIndex(message => message.role === 'system')
  let last = prompt.length - 1
  while (last >= 0 && prompt[last].role === 'system') last--
  return prompt.map((message, index) => {
    let next: Message = message
    const hint = message.providerOptions?.anthropic?.cacheControl
    if (index === system || (message.role === 'system' && hint && typeof hint === 'object' && !Array.isArray(hint) && hint.type === 'ephemeral')) next = mark(next)
    if (index === last) {
      next = mark(next)
      if (Array.isArray(next.content) && next.content.length) {
        const parts = [...next.content] as { providerOptions?: Record<string, Record<string, unknown>> }[]
        parts[parts.length - 1] = mark(parts[parts.length - 1])
        next = { ...next, content: parts } as Message
      }
    }
    return next
  })
}
