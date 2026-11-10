/** A persisted execution prompt and its independently recorded, code-point task range. */
export type RunPromptSource = { prompt: string; promptTaskStart?: number | null; promptTaskLength?: number | null }
export type CopiedRunPrompt = { prompt: string; promptTaskStart: number | null; promptTaskLength: number | null }

export function validTaskRange(prompt: string, start: number | null | undefined, length: number | null | undefined): boolean {
  return Number.isInteger(start) && Number.isInteger(length) && start! >= 0 && length! >= 0 && start! + length! <= Array.from(prompt).length
}

/** Copy the prompt and range as one value. A transformation may retain a prefix
 * of the original prompt, then append host guidance. Any host prefix must be
 * supplied explicitly; content is never searched for a task or instruction heading.
 * Only unchanged source code points can remain in the visible range. */
export function copyRunPrompt(source: RunPromptSource, prompt = source.prompt, prepended = ''): CopiedRunPrompt {
  const unknown = { prompt, promptTaskStart: null, promptTaskLength: null }
  if (!validTaskRange(source.prompt, source.promptTaskStart, source.promptTaskLength) || !prompt.startsWith(prepended)) return unknown
  const before = Array.from(source.prompt), after = Array.from(prompt.slice(prepended.length))
  let kept = 0
  while (kept < before.length && kept < after.length && before[kept] === after[kept]) kept++
  const start = Math.min(source.promptTaskStart!, kept)
  return { prompt, promptTaskStart: Array.from(prepended).length + start,
    promptTaskLength: Math.max(0, Math.min(source.promptTaskStart! + source.promptTaskLength!, kept) - start) }
}

/** UTF-16 position after the task, for string transforms. Unknown prompts are
 * entirely protected: their words must not be deleted by matching host headings. */
export function protectedTaskEnd(source: RunPromptSource): number {
  return validTaskRange(source.prompt, source.promptTaskStart, source.promptTaskLength)
    ? Array.from(source.prompt).slice(0, source.promptTaskStart! + source.promptTaskLength!).join('').length
    : source.prompt.length
}
