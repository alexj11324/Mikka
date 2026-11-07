import type { ModelCallStreamPart } from '@ai-sdk/workflow'

export type CoordinatorWorkflowStreamPart = ModelCallStreamPart
  | { type: 'coordinator-turn-start'; id: string; quietEligible: boolean; modelStream?: 'scoped-v1' }
  /** All SDK parts, including resets and finish, keep their producer's turn. */
  | { type: 'coordinator-model-part'; id: string; part: ModelCallStreamPart }
  /** 停止 cut turn `id` short: what streamed before it is the reply's last words (lib/coordinator/stop.ts). */
  | { type: 'coordinator-turn-stopped'; id: string }
  | { type: 'coordinator-turn-committed'; id: string; through: number; quiet: boolean }

/** Old recorded runs keep their raw format; a scoped turn accepts only its own envelope. */
export function coordinatorModelPart(part: CoordinatorWorkflowStreamPart, id: string, scoped: boolean): ModelCallStreamPart | null {
  switch (part.type) {
    case 'coordinator-model-part': return part.id === id ? part.part : null
    case 'coordinator-turn-start':
    case 'coordinator-turn-stopped':
    case 'coordinator-turn-committed': return null
    default: return scoped ? null : part
  }
}

export type CoordinatorStreamEvent =
  | { type: 'start'; id: string }
  | { type: 'text'; id: string; delta: string }
  | { type: 'reset'; id: string; text: string }
  | { type: 'committed'; id: string; through: number; quiet: boolean }
  /**
   * A tool the reply is using: its name, how it stands, and the first characters of its input and output
   * (`TOOL_PREVIEW_CHARS`, masked; left out when they would carry a saved secret), as the stored chat keeps them.
   */
  /** `at` (on the call): the length of the reply's text when it ran, so the chat draws it after those words. */
  | { type: 'tool'; id: string; call: string; name: string; state: 'running' | 'done' | 'error'; input?: string; output?: string; quote?: string; at?: number; target?: string; displayName?: string; errorCode?: string; errorDetail?: string }
  /**
   * The model started or stopped thinking, and what it thinks as it goes: each `delta` is the next masked piece of
   * readable reasoning (none for encrypted or empty reasoning; nothing past a saved secret). `reset` replaces the
   * turn's reasoning so far with `text` when a retried model step drops its partial attempt.
   */
  | { type: 'thinking'; id: string; state: 'start' | 'end' }
  | { type: 'thinking'; id: string; state: 'delta'; text: string }
  | { type: 'thinking'; id: string; state: 'reset'; text: string }
  | { type: 'error' }
