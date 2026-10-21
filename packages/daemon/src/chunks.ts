// Run output format: Vercel AI SDK `UIMessageChunk`s (types only, the `ai`
// package is never used to call a model). AI Elements and `useChat` render
// them directly; Orvilo-specific facts travel as `data-*` parts.
import type { RunPublish, RunState, StopReason } from "@orvilo/protocol"
import type { PlanSection } from "@orvilo/protocol/plan"
import type { UIMessage, UIMessageChunk } from "ai"

export type OrviloDataTypes = {
  /** A file the agent changed, path relative to the worktree root. */
  "file-change": { path: string; change: "added" | "modified" | "deleted" }
  /** Usage as reported by the harness; `source` says where it came from. */
  usage: {
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    source: string
  }
  /** The daemon's commit (and push) of a verified hand-in. */
  publish: RunPublish
  /** Run state transitions written by the daemon. */
  "run-state": { state: RunState; error?: string; stopReason?: StopReason }
  /**
   * The spec a `plan` run wrote (ADR ORV-205). `specId` is the row the server
   * stores, so the card reads the spec's live status from there.
   */
  spec: {
    specId: string
    title: string
    summary: string
    sections: PlanSection[]
  }
  /**
   * The split that plan run proposes. Nothing exists yet: a person approves
   * it (`split.approve`) before any issue is created.
   */
  split: {
    specId: string
    summary: string
    issues: {
      key: string
      title: string
      note: string
      criteria: string[]
      blockedBy: string[]
      parentKey?: string
    }[]
  }
}

export type RunChunk = UIMessageChunk<unknown, OrviloDataTypes>
export type RunMessage = UIMessage<unknown, OrviloDataTypes>

export function runStateChunk(
  state: RunState,
  error?: string,
  stopReason?: StopReason
): RunChunk {
  return {
    type: "data-run-state",
    // Relayed live, never stored in a message (ADR 0018).
    transient: true,
    data: {
      state,
      ...(error ? { error } : {}),
      ...(stopReason ? { stopReason } : {}),
    },
  }
}

/** Light structural check for chunks read from disk or fixtures. */
export function isRunChunk(value: unknown): value is RunChunk {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  )
}
