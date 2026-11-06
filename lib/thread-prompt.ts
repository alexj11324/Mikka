/**
 * What a thread shows of its run's prompt: the task the person or Coordinator
 * wrote, recorded at dispatch (`agent_runs."promptTaskStart"`/`"promptTaskLength"`,
 * in code points). The Agent still receives the whole prompt; the rest (Factory
 * guidance, repository checks, standing instructions) shows only on request.
 * A run without the range (older runs, other sources) shows its prompt as before.
 */
export function threadPromptView(prompt: string, start: number | null | undefined, length: number | null | undefined): { task: string; hasInstructions: boolean } {
  if (start == null || length == null || start < 0 || length <= 0) return { task: prompt, hasInstructions: false }
  const points = Array.from(prompt)
  if (start >= points.length) return { task: prompt, hasInstructions: false }
  const task = points.slice(start, start + length).join('')
  return { task, hasInstructions: points.length > length && task.trim() !== prompt.trim() }
}
