/**
 * Work reaches a thread only through a task (Alex; dispatch_run requires an issueId).
 * Demo threads written without one get their own team task, assigned to the
 * thread's Bot, with the status its run implies, so the board and the thread
 * list tell the same story.
 */
/** The board status a thread's run implies. */
export const STATUS_OF_RUN = { queued: 'todo', preparing: 'doing', running: 'doing', waiting_input: 'review', succeeded: 'done', failed: 'todo', stopped: 'todo', cancelled: 'canceled' }

const taskKey = run => `task-${run.key}`

/** A task's board status for a run status. */
export const taskStatus = runStatus => STATUS_OF_RUN[runStatus] ?? 'todo'

/** A thread's title: the first line of its prompt. */
export const threadTitle = prompt => String(prompt ?? '').split('\n')[0].trim().slice(0, 200)

/** The task each demo run without one gets. */
export function threadIssues(runs) {
  return runs.filter(run => !run.issue).map(run => ({
    key: taskKey(run), status: taskStatus(run.status), priority: 'normal',
    title: threadTitle(run.prompt), labels: [], assignee: `bot:${run.bot}`, body: [],
  }))
}

/** Every run, pointed at its own task or the one threadIssues made for it. */
export function withIssues(runs) {
  return runs.map(run => run.issue ? run : { ...run, issue: taskKey(run) })
}

/** The seeder writes no thread without a task. */
export function assertEveryRunHasIssue(runs) {
  const missing = runs.filter(run => !run.issueId)
  if (missing.length) throw new Error(`Demo runs without a task: ${missing.map(run => run.key).join(', ')}`)
}
