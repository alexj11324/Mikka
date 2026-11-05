/** Shared lifetime for durable due timers; keep their event histories bounded. */
export const DUE_TIMER_LIFETIME_MS = 6 * 60 * 60_000

/** Hook tokens for workflows woken by a write (lib/workflow-wake.ts). Deterministic,
 * so a writer can wake a workflow it did not start. Pure: workflow code imports it. */
export const wakeTokens = {
  /** The lifecycle maintaining a cloud run's thread machine (thread-machine, factory-stage). */
  threadMachine: (runId: string) => 'thread-machine:' + runId,
  /** A web subagent's workflow (workflows/subagent), woken by any change to its row or its approvals. */
  subagent: (subagentId: string) => 'subagent:' + subagentId,
  /** A Bot chat's pending Coordinator wake deadline (workflows/coordinator-wake-recovery), woken when a lease it waits behind is released. */
  coordinatorWake: (userId: string, botId: string) => 'coordinator-wake:' + JSON.stringify([userId, botId]),
  /** The one durable due timer of a reconciled job (workflows/due-timer), woken by writes that make its work due sooner. */
  dueTimer: (kind: string) => 'due-timer:' + kind,
  /** Non-force election for a production timer deployment, separate from its stable wake token. */
  dueTimerDeployment: (kind: string, deploymentId: string) => 'due-timer-owner:' + JSON.stringify([kind, deploymentId]),
}
