import { validTaskRange } from './run-prompt-copy'

/**
 * What a thread shows of its run's prompt: the task the person or Coordinator
 * wrote, recorded at dispatch (`agent_runs."promptTaskStart"`/`"promptTaskLength"`,
 * in code points). The Agent still receives the whole prompt; the rest (Factory
 * guidance, repository checks, standing instructions) shows only on request.
 * An unknown range is not proof that execution instructions were a user message.
 * Legacy text is shown only when the caller has an independent trusted user text.
 */
export function threadPromptView(prompt: string, start: number | null | undefined, length: number | null | undefined, trustedTask = ''): { task: string; hasInstructions: boolean } {
  if (!validTaskRange(prompt, start, length)) return { task: trustedTask, hasInstructions: !!prompt && prompt !== trustedTask }
  const points = Array.from(prompt)
  const task = points.slice(start!, start! + length!).join('')
  return { task, hasInstructions: points.length > length! && task.trim() !== prompt.trim() }
}
