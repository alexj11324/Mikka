// The one interface every harness adapter implements (ADR 0003). It is
// session-shaped on purpose: ACP (`session/new`, `session/prompt`,
// `session/cancel`, `session/load`, via @agentclientprotocol/sdk in Stage 1)
// and `codex app-server` (thread start / turn / interrupt / resume) both map
// onto start -> events -> send / cancel, plus `resume(sessionId)`. A
// follow-up run starts by continuing the earlier run's conversation
// (`StartOptions.continueSession`), so a run never ends the chat.
import type {
  HandoffReport,
  Harness,
  RunKind,
  RunPolicy,
  RunSkill,
  StopReason,
} from "@mikka/protocol"

import type { RunChunk } from "../chunks"
import type { Logger } from "../log"

/**
 * Terminal event of a session; the daemon turns it into the run's end state.
 * A session that ends on its own is not success: the run only succeeds when
 * `stopReason` is `submitted` (the agent handed in its work explicitly).
 */
export interface ExitEvent {
  type: "exit"
  outcome: "succeeded" | "failed" | "cancelled"
  /** Defaults: `turn_ended` for succeeded, `error` for failed. */
  stopReason?: StopReason
  error?: string
  /** What the agent handed in (submit / ask / blocked call). */
  report?: AgentReport
}

/** The agent's part of the handoff report; the daemon adds the rest. */
export type AgentReport = Partial<
  Pick<
    HandoffReport,
    "summary" | "openQuestions" | "nextStep" | "blockedOn" | "plan" | "criteria"
  >
>

/** Adapter output: UI message chunks, then exactly one `exit`. */
export type AgentEvent = { type: "chunk"; chunk: RunChunk } | ExitEvent

export interface AgentCapabilities {
  /** `send` can deliver a user message while a turn is running. */
  supportsInterject: boolean
  /**
   * `resume(sessionId)` continues a session after a daemon restart, and
   * `start` honours `continueSession`.
   */
  supportsResume: boolean
}

export interface SessionOptions {
  runId: string
  /**
   * What the orchestrator dispatched this run for (ADR 0023). A `plan` run
   * is told to write a spec instead of code (ADR ORV-205).
   */
  kind?: RunKind
  /** The run's worktree; the CLI child runs here. */
  cwd: string
  /** Clean env from `buildChildEnv`; spawn with `extendEnv: false`. */
  env: Record<string, string>
  log: Logger
  /** Domains the repo lets this run reach, on top of the harness's own. */
  networkAllow?: readonly string[]
  /**
   * The workspace's agent policy from the assignment (ADR 0028): domains,
   * the CLI's own permission rules where it has them, the agent's rules.
   */
  policy?: RunPolicy
  /**
   * The skills the run was given (the assignment's `skills`). They are
   * written under the run dir and read into the agent's instructions.
   */
  skills?: readonly RunSkill[]
  /** Mock harness only: fixture to replay. */
  fixture?: string
  /**
   * The model the CLI is asked to run, from the assignment (ADR 0060). It is
   * the model name the harness itself takes; unset means the CLI's own
   * default. A harness that cannot express one ignores it.
   */
  model?: string
  /** Run-scoped messaging endpoint; never the device credential. */
  mcp?: { url: string; token: string; mailboxUrl?: string }
}

export interface StartOptions extends SessionOptions {
  /** The full brief: a new session's first message. */
  prompt: string
  /**
   * A follow-up run in the earlier run's worktree: open that run's session
   * and send `message` (the follow-up alone) as its next user message. When
   * the session cannot be reopened (gone, or the CLI refuses it before it
   * starts), the adapter logs it and starts a new session with `prompt`;
   * the returned `sessionId` tells which happened.
   */
  continueSession?: {
    sessionId: string
    /** The run that last used the session (its run dir holds the harness home). */
    runId: string
    message: string
  }
}

export interface AgentSession {
  readonly sessionId: string
  /** Single-consumer stream; ends after the `exit` event. */
  events(): AsyncIterable<AgentEvent>
  /** User message / interjection. */
  send(text: string): Promise<void>
  cancel(): Promise<void>
  /**
   * Optional: the daemon stops consuming this session without ending it
   * (daemon shutdown); release processes and handles, keep it resumable.
   */
  detach?(): Promise<void>
}

export interface AgentAdapter {
  readonly harness: Harness
  readonly capabilities: AgentCapabilities
  /** Host env var names this adapter's CLI needs (still subject to the deny list). */
  readonly envAllow: readonly string[]
  start(options: StartOptions): Promise<AgentSession>
  resume(sessionId: string, options: SessionOptions): Promise<AgentSession>
}
