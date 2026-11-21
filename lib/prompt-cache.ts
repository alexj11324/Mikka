import type { LanguageModel, SystemModelMessage } from 'ai'

/**
 * Prompt caching for the Coordinator's model calls.
 *
 * A provider caches a request's prefix: tools, then system, then messages. The
 * system prompt separates rules (including the card catalog and personal
 * instructions), repository/model context, and the changing memory/live tail.
 * Claude's stable layers and last conversation message have their own
 * `ephemeral` cache_control breakpoints. Supported Codex subscription models
 * use the provider's implicit caching: the stable system layers stay first and
 * the changing system tail follows all history, retaining its instruction role.
 * Unknown prompt layouts keep their existing order.
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

/** Boundaries become system messages, never options of the model call itself. */
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
    if (index === system || (message.role === 'system' && hint && typeof hint === 'object' && !Array.isArray(hint) && 'type' in hint && hint.type === 'ephemeral')) next = mark(next)
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

/**
 * Recognize only preparation's layered prompt. Move its dynamic tail after
 * history without changing any message, role or option. CPA maps each system
 * message to developer; the tail must follow all tool results, not split a
 * call/result pair. No subscription-specific cache fields are sent.
 */
export function withCodexStablePrefix(prompt: Prompt, modelId: string): Prompt {
  // A layout gate, not a model selection catalogue. Unknown aliases and older
  // generations retain their existing wire format.
  if (!/^gpt-(?:5\.6(?:-(?:luna|sol|terra))?|6-(?:luna|sol|astra)|6\.1-(?:sol|terra))$/.test(modelId)) return prompt
  let stable = 0
  for (const message of prompt) {
    if (message.role !== 'system') break
    const hint = message.providerOptions?.anthropic?.cacheControl
    if (!hint || typeof hint !== 'object' || Array.isArray(hint) || !('type' in hint) || hint.type !== 'ephemeral') break
    if (typeof message.content !== 'string' || message.content.length === 0 || ++stable > 2) return prompt
  }
  const tail = prompt[stable]
  if (stable === 0 || tail?.role !== 'system' || typeof tail.content !== 'string' || tail.content.length === 0 || tail.providerOptions?.anthropic?.cacheControl !== undefined) return prompt
  const history = prompt.slice(stable + 1)
  if (history.length === 0 || history.some(message => message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool')) return prompt
  return [...prompt.slice(0, stable), ...history, tail]
}
