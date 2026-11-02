import type { LanguageModel, SystemModelMessage } from 'ai'

/**
 * Prompt caching for the Coordinator's model calls.
 *
 * A provider caches a request's prefix: tools, then system, then messages. The
 * system prompt starts with what is the same on every turn (rules, the card
 * catalog, the person's own instructions) and ends with what changes (memory,
 * GitHub lines, which computers are online). So the system prompt is sent as
 * two system messages, and a cache breakpoint goes on the first one and on the
 * last message. The second and third model calls of a turn then read the
 * whole earlier prompt from the cache, and the next turn reads tools, the
 * stable rules and the history it shares.
 *
 * Claude needs explicit breakpoints (OpenAI and DeepSeek cache prefixes on
 * their own); a breakpoint is an `ephemeral` cache_control, at most four per
 * request, and this uses two.
 */

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type Prompt = Parameters<V4Model['doStream']>[0]['prompt']
type Message = Prompt[number]

/** The system prompt as one message, or split where its stable prefix ends. Pure: runs in the Workflow body. */
export function cacheableInstructions(text: string, stable?: number): string | SystemModelMessage[] {
  if (!stable || stable <= 0 || stable >= text.length) return text
  return [{ role: 'system', content: text.slice(0, stable) }, { role: 'system', content: text.slice(stable) }]
}

/** preparePrompt's result as WorkflowAgent options: `stable` becomes the split, never an option of its own. */
export function promptOptions<T extends { instructions?: string; stable?: number }>({ instructions, stable, ...rest }: T): Omit<T, 'instructions' | 'stable'> & { instructions?: string | SystemModelMessage[] } {
  return instructions === undefined ? rest : { ...rest, instructions: cacheableInstructions(instructions, stable) }
}

/**
 * Marks the first system message and the last message as cache breakpoints.
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
    if (index === system) next = mark(next)
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
