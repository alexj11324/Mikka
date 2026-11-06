/** How long a stream opened at send waits for the turn that takes the message to start. */
export const TURN_START_WAIT_MS = 10_000

type Listener = { consume(payload: string): unknown; close(): Promise<void> }

/**
 * The run that holds chat `botId`, waiting up to `deadline` for a turn that is
 * about to start: the person's message is still in the inbox. takeInbox
 * NOTIFYs when a turn takes the chat (lib/coordinator/store.ts), so a waiter
 * reads again only when told, never on a timer (#1212). Null when nothing
 * waits there, the deadline passed, or no listener could be opened.
 */
export async function awaitTurnHolder<L extends Listener>(botId: string, deadline: number, deps: {
  read(): Promise<{ holder: string | null; waiting: boolean }>
  listen(): Promise<L | null>
  next(listener: L, botId: string, ms: number): Promise<void>
  now(): number
}): Promise<string | null> {
  let listener: L | null | undefined
  try {
    for (;;) {
      listener?.consume(botId)
      const state = await deps.read()
      if (state.holder) return state.holder
      if (!state.waiting || deps.now() >= deadline || listener === null) return null
      if (listener === undefined) {
        // Listen, then read again at once: a turn that took the chat before LISTEN is seen by that read.
        listener = await deps.listen().catch(() => null)
        continue
      }
      await deps.next(listener, botId, deadline - deps.now())
    }
  } finally { await listener?.close() }
}
