// Per-thread interaction mode (#1730): plan, execute, ask. One contract
// shared by the server (which stores the thread's choice and freezes it on
// each run), the daemon (which applies it to the harness and its own tool
// gate) and the API/UI.
//
// The mode is not a third permission system. It is an intent layer that
// narrows the existing RunPolicy and the existing tool-approval gate:
// - plan:   the run only reads. `applyThreadMode` makes the policy read-only
//           (ADR 0046), and every host-side write path refuses it.
// - execute: the run is exactly what the policy already says.
// - ask:    each risky step waits for the person's decision. Reads run; every
//           host-side write and every harness-native risky tool asks first.
//           A refusal or a lost decision never turns into an allow.
import { z } from 'zod'
import { applyApprovalMode, type RunPolicy } from './agent-policy'
import type { Harness } from './harness'

export const THREAD_MODES = ['plan', 'execute', 'ask'] as const
export type ThreadMode = (typeof THREAD_MODES)[number]

export const threadModeSchema = z.enum(THREAD_MODES)
export const DEFAULT_THREAD_MODE: ThreadMode = 'execute'

export function isThreadMode(value: unknown): value is ThreadMode {
  return typeof value === 'string' && (THREAD_MODES as readonly string[]).includes(value)
}

/** The stored mode, or execute for anything a row should not have held. */
export function resolveThreadMode(stored: unknown): ThreadMode {
  return isThreadMode(stored) ? stored : DEFAULT_THREAD_MODE
}

/**
 * The policy a run actually gets. `plan` is the existing read-only policy
 * (ADR 0046), which denies every configurable action that changes something
 * and marks the run read-only. `execute` and `ask` keep the policy; ask is
 * enforced where a tool runs, not by widening or narrowing the stored grant.
 */
export function applyThreadMode(policy: RunPolicy, mode: ThreadMode): RunPolicy {
  return mode === 'plan' ? applyApprovalMode(policy, 'read_only') : policy
}

/** Effects a tool or host operation can have, as the mode table sees them. */
export const THREAD_MODE_EFFECTS = ['read', 'write', 'external', 'merge'] as const
export type ThreadModeEffect = (typeof THREAD_MODE_EFFECTS)[number]

/**
 * Whether the mode permits an effect without asking. `plan` reads only: source
 * writes, external side effects (an app/GitHub write, a push) and PR merges
 * are refused at the execution layer. `ask` permits nothing silently except
 * reads. `execute` leaves the existing policy in charge.
 */
export function threadModeAllowsWithoutAsking(mode: ThreadMode, effect: ThreadModeEffect): boolean {
  if (effect === 'read') return true
  return mode === 'execute'
}

/** The reason a host tool path refuses an effect under a thread mode. */
export type ThreadModeDenial = 'threadModePlanReadOnly'

export function threadModeDenial(mode: ThreadMode, effect: ThreadModeEffect): ThreadModeDenial | null {
  return threadModeAllowsWithoutAsking(mode, effect) ? null : mode === 'plan' ? 'threadModePlanReadOnly' : null
}

/**
 * What each harness can enforce natively. A mode with no enforcement on the
 * selected harness is refused at admission (`threadModeUnsupported`), never
 * silently run without it. Plan is enforced by the run policy and the host
 * tool paths on every harness; ask needs a native per-tool approval surface.
 */
export const THREAD_MODE_HARNESS_SUPPORT = {
  claude_code: { plan: 'enforced', execute: 'enforced', ask: 'enforced' },
  codex: { plan: 'enforced', execute: 'enforced', ask: 'enforced' },
  // Cursor's ACP permission bridge accepts every tool and has no native
  // read-only or ask surface; the mock replays a fixture. Refuse both modes
  // rather than run them without enforcement.
  cursor: { plan: 'unsupported', execute: 'enforced', ask: 'unsupported' },
  mock: { plan: 'unsupported', execute: 'enforced', ask: 'unsupported' },
} as const satisfies Record<Harness, Record<ThreadMode, 'enforced' | 'unsupported'>>

export type ThreadModeSupport = 'enforced' | 'unsupported'

export function threadModeSupport(harness: string, mode: ThreadMode): ThreadModeSupport | null {
  if (!Object.hasOwn(THREAD_MODE_HARNESS_SUPPORT, harness)) return null
  return THREAD_MODE_HARNESS_SUPPORT[harness as Harness][mode]
}

/** The lines appended to a run's brief. Never the sandbox; the policy and
 * the host tool paths enforce the mode. These tell the agent what it is for. */
export function threadModeInstructions(mode: ThreadMode): string[] {
  if (mode === 'plan') return [
    '- This thread is in Plan mode. Inspect the worktree, the diff and history, then produce a readable plan. Do not change files, commit, push, merge, install dependencies or use an app or GitHub write. When you are done, hand in the plan through `submit`; a later Execute thread carries it out.',
  ]
  if (mode === 'ask') return [
    '- This thread is in Ask mode. Reads run normally. Every risky step (a file change, a shell command, a push, an external write) waits for the person to approve that exact operation. A declined or unanswered request is refused; do not retry it or work around it.',
  ]
  return []
}

/** One thread's mode and optimistic-concurrency version, as the API returns it. */
export const threadModeStateSchema = z.strictObject({
  mode: threadModeSchema,
  /** Bumped on every explicit transition; a stale write is refused. */
  version: z.number().int().nonnegative(),
  /** The mode frozen on the run the caller named, when the read named one. */
  frozenMode: threadModeSchema.optional(),
  /** The frozen policy revision the run is gated on; absent before a claim. */
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
export type ThreadModeState = z.infer<typeof threadModeStateSchema>

/** A mode transition request. `expectedVersion` fences a stale picker. */
export const threadModeTransitionSchema = z.strictObject({
  mode: threadModeSchema,
  expectedVersion: z.number().int().nonnegative(),
})
export type ThreadModeTransition = z.infer<typeof threadModeTransitionSchema>
