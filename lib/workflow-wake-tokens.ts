/** Hook tokens for workflows woken by a write (lib/workflow-wake.ts). Deterministic,
 * so a writer can wake a workflow it did not start. Pure: workflow code imports it. */
export const wakeTokens = {
  /** The lifecycle maintaining a cloud run's thread machine (thread-machine, factory-stage). */
  threadMachine: (runId: string) => 'thread-machine:' + runId,
}
