// What a harness can enforce about a risky tool call, and nothing else.
//
// There is deliberately no `plan | execute | ask` enum here, and nothing is
// stored per task. Two independent facts used to share one vocabulary:
//
// - Reading vs writing is a property of the run's policy, not a mode. The
//   existing read-only policy (ADR 0046) already says it and every host tool
//   path already refuses writes under it, so it needs no per-harness matrix.
// - Whether a risky call waits for a person is a property of the resource
//   being reached, decided by the policy layer that resolved that action to
//   `ask`. An approval is one exact request bound to one run
//   (`agent_tool_approvals`); it grants no standing authority.
//
// This module keeps only what is genuinely about the harness: can this CLI
// hand one tool call to a person and act on the answer?
import { z } from 'zod'
import type { RunPolicy } from './agent-policy'
import type { Harness } from './harness'

/**
 * Whether one harness has a per-call surface to ask a person about a single
 * tool call. `native` means the adapter consults one; `unsupported` means the
 * CLI would accept the call with no way to ask first.
 */
export const HARNESS_TOOL_APPROVAL = {
  claude_code: 'native',
  codex: 'native',
  // Cursor's ACP permission bridge accepts every tool and the mock replays a
  // fixture. Both are refused at claim when a run must ask, rather than run
  // with the ask silently ignored.
  cursor: 'unsupported',
  mock: 'unsupported',
} as const satisfies Record<Harness, 'native' | 'unsupported'>

export type HarnessToolApproval = (typeof HARNESS_TOOL_APPROVAL)[Harness]

/** `HARNESS_TOOL_APPROVAL[harness]`, or null when the host names an unknown one. */
export function harnessToolApproval(harness: string): HarnessToolApproval | null {
  return Object.hasOwn(HARNESS_TOOL_APPROVAL, harness) ? HARNESS_TOOL_APPROVAL[harness as Harness] : null
}

/** Whether this harness has a per-call surface to ask a person at all. */
export function harnessCanAsk(harness: string): boolean {
  return harnessToolApproval(harness) === 'native'
}

/**
 * Policy actions a native per-call gate expresses, i.e. the ones where the
 * unit of risk is exactly one tool call and no other layer already enforces
 * it:
 *
 * - `install_dependency` asks before one specific install command runs.
 * - `write_outside_repo` is enforced by the sandbox denying the path, and
 *   `computer_use` by its own broker; neither is a CLI tool callback, and both
 *   default to `ask`, so routing them here would change every run's behavior.
 *
 * Empty for the defaults (installs are allowed), which is why a run with a
 * default policy keeps asking nothing per tool (decision 2026-11-01-2335).
 */
export const GATE_EXPRESSIBLE_ACTIONS = ['install_dependency'] as const
export type GateExpressibleAction = (typeof GATE_EXPRESSIBLE_ACTIONS)[number]

/** The policy actions this run's daemon must ask a person about, sorted. */
export function policyAskActions(policy: RunPolicy): GateExpressibleAction[] {
  if (policy.readOnly) return []
  return GATE_EXPRESSIBLE_ACTIONS.filter(action => policy.permissions[action] === 'ask')
}

/** Whether this run's policy asks a person about at least one gate action. */
export function policyRequiresApproval(policy: RunPolicy): boolean {
  return policyAskActions(policy).length > 0
}

/**
 * Whether a run may go to this harness: a run that must ask cannot run on a
 * harness with no way to ask. `unsupported` is a refusal at claim, never a
 * run that quietly ignores the ask.
 */
export function runApprovalSupport(policy: RunPolicy, harness: string): 'required' | 'not_required' | 'unsupported' {
  if (!policyRequiresApproval(policy)) return 'not_required'
  return harnessCanAsk(harness) ? 'required' : 'unsupported'
}

/** One run's approval state as the protocol reports it, never inferred. */
export const runApprovalStateSchema = z.strictObject({
  /** The policy actions this run's daemon asks about, sorted. */
  asks: z.array(z.enum(GATE_EXPRESSIBLE_ACTIONS)),
  /** The reported revision of the policy these asks came from. */
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
})
export type RunApprovalState = z.infer<typeof runApprovalStateSchema>
