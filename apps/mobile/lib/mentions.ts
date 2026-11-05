import type { CitationSource } from './types'

const RUN = /\[\[run:([0-9a-f-]{36})\]\]/gi

/**
 * The tasks a reply already shows through one of their threads. A reply that cites a thread and the task it works on
 * would draw two chips with the same title (the thread is named by its task); the thread's chip stays, since it
 * opens the work and names the task, and the task's own chip is left out.
 */
export function tasksShownByThreads(text: string, sources: Record<string, CitationSource>): Set<string> {
  const covered = new Set<string>()
  for (const match of text.matchAll(RUN)) {
    const run = sources[match[1].toLowerCase()]
    if (run?.kind === 'run' && run.issue) covered.add(run.issue.id.toLowerCase())
  }
  return covered
}
