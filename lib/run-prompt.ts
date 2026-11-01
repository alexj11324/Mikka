/** The issue, optional run note and the executing agent's standing role. */
export function runPrompt(title: string, body: string, instructions: string, note?: string): string {
  const parts = [`# ${title}`]
  if (body) parts.push(body)
  if (note) parts.push('## Notes for this run', note)
  parts.push('---', 'Work in the repository checked out for this run. Follow the delivery rules supplied for this run; commit and push only when those rules authorize it. When you are done, hand in your work with a short summary of what changed.')
  if (instructions) parts.push('## Your standing instructions', instructions)
  return parts.join('\n\n').slice(0, 100_000)
}
