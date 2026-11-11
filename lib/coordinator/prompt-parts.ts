// How the Coordinator's system prompt is put together: the rules, the cached
// repository/model context, the person's own notes, what Mikka has learnt about
// them, and the per-turn tail. Pure string composition, kept free of imports so
// it can be read and tested without the conversation model.
//
// Re-exported by lib/coordinator/context.ts, which is where callers import it.

/**
 * The system prompt with the person's memory after it. `profile` is what Mikka
 * has learnt about them (lib/profile/prompt.ts profileSection): a named section
 * of its own, after their own notes, so the two never read as one thing. The
 * person's own words come first because they outrank Mikka's deductions.
 */
export function instructionsWithMemory(instructions: string, memory: string, profile = ''): string {
  const notes = memory ? `${instructions}\n\n## What the person asked you to remember\n${memory}` : instructions
  return profile ? `${notes}\n\n${profile}` : notes
}

/** The cached context after the rules: the GitHub lines, then the allowed models list; empty parts are left out. */
export function cachedContextLines(...parts: string[]): string {
  return parts.filter(Boolean).join('\n')
}

/**
 * Keep a rules breakpoint before the repository/model context: a repository push or a newly used repository
 * can change that context between turns, while the rules and tool definitions remain reusable.
 *
 * `profile` is what Mikka has learnt about the person; it rides with the memory
 * rather than in `tail`, so it is part of the system digest and the provider
 * caches it from one turn to the next instead of paying for it every turn.
 */
export function promptWithCachedContext(rules: string, github: string, memory: string, tail: string, profile = ''): { instructions: string; stable: number; stableRules: number } {
  const prefix = github ? `${rules}\n${github}` : rules
  return { stableRules: rules.length, stable: prefix.length, instructions: instructionsWithMemory(prefix, memory, profile) + tail }
}
