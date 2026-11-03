/** The issue, optional run note and the executing agent's standing role. */
export function runPrompt(title: string, body: string, instructions: string, note?: string): string {
  const parts = [`# ${title}`]
  if (note) parts.push('## Notes for this run', note)
  parts.push('---', 'Work in the repository checked out for this run. Follow the delivery rules supplied for this run; commit and push only when those rules authorize it. When you are done, hand in your work with a short summary of what changed.')
  if (instructions) parts.push('## Your standing instructions', instructions)
  if (body) {
    // Reserve the current request and execution guidance before shortening
    // issue context; slicing the whole brief silently removed its tail.
    const budget = Math.max(0, 100_000 - parts.join('\n\n').length - 2)
    const marker = '\n\n[Issue context truncated]'
    parts.splice(1, 0, body.length <= budget ? body : body.slice(0, Math.max(0, budget - marker.length)) + marker)
  }
  return parts.join('\n\n').slice(0, 100_000)
}
