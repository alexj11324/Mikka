// The part of the `codex app-server` protocol the Codex adapter uses. Copied
// from `codex app-server generate-ts` (codex-cli 0.162.1, `v2/`), trimmed to
// the fields read here; regenerate with `bun run codex:types` and compare
// when bumping the CLI. Transport: newline-delimited JSON-RPC 2.0 on stdio
// (no Content-Length headers).

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type AskForApproval = "untrusted" | "on-request" | "never"

/** Experimental official app-server host-managed auth. Private runner RPC only. */
export interface ChatGPTAuthTokens {
  accessToken: string
  chatgptAccountId: string
  chatgptPlanType?: string
}

export type UserInput = {
  type: "text"
  text: string
  text_elements: unknown[]
}

export interface ThreadStartParams {
  /** Experimental host tools (app-server `dynamicTools`). */
  dynamicTools?: { type: 'function'; name: string; description: string; inputSchema: Record<string, unknown> }[]
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  model?: string | null
  developerInstructions?: string | null
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string
}

export interface ThreadResponse {
  thread: { id: string }
  model?: string
}

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
}

export interface TurnSteerParams {
  threadId: string
  input: UserInput[]
  expectedTurnId: string
}

export interface TurnInterruptParams {
  threadId: string
  turnId: string
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"

export interface Turn {
  id: string
  status: TurnStatus
  error: TurnError | null
}

/** `codexErrorInfo` tells a usage limit or HTTP failure apart (e.g. "usageLimitExceeded"). */
export interface TurnError { message: string; codexErrorInfo?: unknown }

export type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null }

export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[] }
  | {
      type: "commandExecution"
      id: string
      command: string
      aggregatedOutput: string | null
      exitCode: number | null
    }
  | {
      type: "fileChange"
      id: string
      changes: { path: string; kind: PatchChangeKind }[]
      status: string
    }
  | {
      type: "mcpToolCall"
      id: string
      server: string
      tool: string
      arguments: unknown
      result: { content: unknown[] } | null
      error: { message: string } | null
    }
  | { type: string; id: string }

export interface ItemNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface DeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface TurnNotification {
  threadId: string
  turn: Turn
}

export interface ErrorNotification {
  error: TurnError
  willRetry: boolean
  threadId: string
  turnId: string
}

export interface TokenUsageNotification {
  threadId: string
  tokenUsage: {
    total: { inputTokens: number; outputTokens: number }
  }
}

/** `account/rateLimits/updated`: the ChatGPT plan's windows, with their resets in Unix seconds. */
export interface RateLimitsNotification {
  rateLimits: { primary?: { usedPercent?: number; resetsAt?: number | null } | null; secondary?: { usedPercent?: number; resetsAt?: number | null } | null }
}
