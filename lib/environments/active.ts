/**
 * In-process cancel for a run action that this server instance is running.
 * A cancel on another instance still reaches it through the execution row and
 * the recorded pid; this registry only makes the same-instance path immediate.
 */
const controllers = new Map<string, AbortController>()

export function registerRunAction(executionId: string, controller: AbortController): void {
  controllers.set(executionId, controller)
}

export function unregisterRunAction(executionId: string, controller: AbortController): void {
  if (controllers.get(executionId) === controller) controllers.delete(executionId)
}

export function abortRunAction(executionId: string): boolean {
  const controller = controllers.get(executionId)
  if (!controller) return false
  controller.abort()
  return true
}
