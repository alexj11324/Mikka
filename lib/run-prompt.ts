import { PROJECT_DECISION_INSTRUCTIONS } from './project-decision-prompt'

/** The issue, optional run note and the executing agent's standing role. */
export function runPrompt(title: string, body: string, instructions: string, note?: string): string {
  const parts = [`# ${title}`]
  if (note) parts.push('## Notes for this run', note)
  parts.push('---', 'Before editing, compare this task with the actual Git origin, HEAD and repository files. If this checkout is wrong, identify the correct repository using the owner’s authorized GitHub access and call the mikka switch_repository tool with the target and evidence. The host preserves this checkout and creates a newly authorized execution in the selected repository. Do not change origin or submit a nested clone as this checkout’s delivery. Independent checks must inspect their fixed candidate; report a mismatch instead of switching. Follow the delivery rules supplied for this run; commit and push only when those rules authorize it. When you are done, hand in your work with a short summary of what changed.')
  parts.push(PROJECT_DECISION_INSTRUCTIONS)
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
