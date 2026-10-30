/** Capture only after the runtime confirms that its CLI has exited cleanly.
 * Errors deliberately propagate: an interrupted or oversized snapshot cannot
 * be used as evidence of a completed session. */
export async function finalizeHostedSession(stopAndConfirm: () => Promise<void>, save: () => Promise<void>): Promise<void> {
  await stopAndConfirm()
  await save()
}
