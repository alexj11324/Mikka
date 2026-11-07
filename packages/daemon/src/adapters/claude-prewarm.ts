// Per-task ownership of an official SDK spare. This module is intentionally
// not wired into the runner until the original CLI's anonymous claim control
// has proved the required MCP/cwd behavior. There is no pool or cold fallback.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { Query, SDKUserMessage, SpareProcess } from '@anthropic-ai/claude-agent-sdk'

/** All values come from the same authorized task and its prepared lease.
 * No credential, prompt, or user-controlled replacement is stored here. */
export interface ClaudePrewarmBinding {
  readonly runId: string
  readonly sessionId: string
  readonly cwd: string
  readonly deviceId: string
  readonly bindingId: string
  readonly ownerId: string
  readonly workspaceId: string
  readonly consumerId: string
  readonly accountId: string
  readonly revision: number
  readonly model: string
  readonly policyHash: string | null
}

/** Input remains private and empty through prewarm, claim, and validation. */
class ClaimedPromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false
  constructor(private readonly sessionId: string) {}
  push(text: string) {
    if (this.closed) throw Error('Claude prepared session is closed')
    const uuid = randomUUID()
    this.items.push({ type: 'user', uuid, session_id: this.sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] } })
    this.wake?.(); this.wake = undefined
    return uuid
  }
  close() { this.closed = true; this.items = []; this.wake?.(); this.wake = undefined }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const item = this.items.shift()
      if (item) yield item
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

type State = 'preparing' | 'parked' | 'claiming' | 'ready' | 'closed'
interface PreparedOptions {
  binding: ClaudePrewarmBinding
  signal: AbortSignal
  /** The held local run/lease gate. This must perform no remote request. */
  assertLive(): void
  /** The caller has already fixed env, credential source, MCP, hooks, model,
   * policy and sessionId. Only cwd and appended instructions arrive at claim.
   * Its spawn must honor this lifetime and own a separate POSIX process group. */
  prepare(lifetime: AbortController): Promise<SpareProcess>
  /** Drain only this task's native process group, including descendants. */
  stop(): Promise<void>
}

export function prepareClaudeSession(options: PreparedOptions) {
  const binding = Object.freeze({ ...options.binding })
  const lifetime = new AbortController()
  const prompts = new ClaimedPromptQueue(binding.sessionId)
  let state: State = 'preparing', consumed = false, exited = false
  let spare: SpareProcess | undefined, closing: Promise<void> | undefined
  let verification: Promise<void> | undefined
  const assertOpen = () => {
    lifetime.signal.throwIfAborted()
    if (state === 'closed' || exited) throw Error('Claude prepared session is closed')
    options.assertLive()
  }
  const starting = Promise.resolve().then(async () => {
    assertOpen()
    const value = await options.prepare(lifetime)
    spare = value
    // A parked close rejects claimed even if consume was never called.
    void value.claimed.catch(() => undefined)
    void value.exited.then(() => { exited = true; prompts.close(); abort() })
    return value
  })
  const cancel = (): Promise<void> => {
    if (closing) return closing
    state = 'closed'
    prompts.close()
    // Publish before abort: SDK/lease callbacks may re-enter cancellation.
    closing = Promise.resolve().then(async () => {
      await starting.catch(() => undefined)
      try { spare?.close() }
      finally {
        try { await options.stop() }
        finally {
          await spare?.exited
          await verification?.catch(() => undefined)
          options.signal.removeEventListener('abort', abort)
        }
      }
    })
    lifetime.abort()
    return closing
  }
  const abort = () => { void cancel().catch(() => undefined) }
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  const fail = async (cause: unknown): Promise<never> => {
    try { await cancel() }
    catch (cleanup) { throw new AggregateError([cause, cleanup], 'Claude prepared session cleanup failed', { cause }) }
    throw cause
  }
  const ready = starting.then(() => { assertOpen(); state = 'parked' }).catch(fail)
  // Repository preparation may fail before it joins this promise.
  void ready.catch(() => undefined)
  return {
    ready,
    get state() { return state },
    cancel,
    async consume(input: {
      binding: ClaudePrewarmBinding
      appendSystemPrompt: string
      /** Existing account/source checks and final local authority checks.
       * Honor signal; cancellation closes Query before waiting for this work. */
      verify(query: Query, signal: AbortSignal): Promise<void>
    }) {
      if (consumed) throw Error('Claude prepared session can only be consumed once')
      consumed = true
      try {
        await ready
        assertOpen()
        if ((Object.keys(binding) as Array<keyof ClaudePrewarmBinding>).some(key => input.binding[key] !== binding[key]) ||
          realpathSync(input.binding.cwd) !== binding.cwd) throw Error('Claude prewarm binding changed')
        state = 'claiming'
        const query = spare!.claim({ prompt: prompts, options: {
          cwd: binding.cwd, appendSystemPrompt: input.appendSystemPrompt, permissionMode: 'bypassPermissions',
        } })
        const claimed = await spare!.claimed
        assertOpen()
        if (claimed.sessionId !== binding.sessionId || claimed.cwd !== binding.cwd)
          throw Error('Claude claimed session binding changed')
        verification = Promise.resolve().then(() => input.verify(query, lifetime.signal))
        await verification
        assertOpen()
        state = 'ready'
        return { query, close: cancel, send(text: string) {
          try { assertOpen(); return prompts.push(text) }
          catch (error) { abort(); throw error }
        } }
      } catch (error) { return fail(error) }
    },
  }
}
