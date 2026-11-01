// The brief of a thread's next run (lib/thread-dispatch.ts): the note goes after
// the task like any dispatch note, under its own heading, so the claim can send a
// resumed session only that part (app/v1/devices/[deviceId]/runs/[runId]/claim).

const NOTE_HEADING = '## More work in this thread'

/**
 * The note for the thread's next run: what the dispatch asks for, then how the
 * thread's last run ended, so a fresh session (another machine, or a harness
 * that cannot resume) starts with the thread's context. A resumed session
 * already has it and is sent only this.
 */
export function continuationNote(note: string | undefined, previous: { status: string; stopReason: string | null; error: string | null; summary: string | null; lastReply: string | null }): string {
  const outcome = [`Status: ${previous.status}${previous.stopReason ? ` (${previous.stopReason})` : ''}`,
    previous.summary ? `Summary: ${previous.summary}` : null,
    previous.error ? `Error: ${previous.error}` : null,
    previous.lastReply ? `Last reply: ${previous.lastReply}` : null].filter(Boolean).join('\n')
  return [NOTE_HEADING,
    'This task already has this thread. Continue the same work from where it stopped: check the files and `git status` first, and do not repeat a push, a pull request or a message that already happened.',
    note?.trim() ? `What to do now:\n${note.trim()}` : 'What to do now: continue the task.',
    `How the thread's last run ended:\n${outcome}`].join('\n\n').slice(0, 10_000)
}

/** What a resumed session is sent: the note's part of the run's brief, or null when the brief has none. */
export function continuationFollowUp(prompt: string): string | null {
  const at = prompt.lastIndexOf(NOTE_HEADING)
  if (at < 0) return null
  // The note ends where the brief's closing section begins (lib/run-prompt.ts).
  const end = prompt.indexOf('\n\n---\n\n', at)
  return prompt.slice(at, end < 0 ? undefined : end).trim()
}
