/**
 * The cloud computer as the browser sees it. Mirrors section 5 of
 * docs/design/cloud-computer-backend.md; when the backend lands its zod
 * schemas in packages/protocol, these types come from there instead.
 */

export type MachineState = 'sleeping' | 'waking' | 'running' | 'error'
export type ControlState = 'agent' | 'user' | 'idle'
export type ComputerTool = 'click' | 'type' | 'key' | 'scroll'

/** Screen coordinates on the fixed 1280×800 desktop. */
export const SCREEN_WIDTH = 1280
export const SCREEN_HEIGHT = 800

export type ScreenRect = { x: number; y: number; w: number; h: number }

export type LastAction = { tool: ComputerTool; x?: number; y?: number; rect?: ScreenRect; at: string }

export type ApprovalView = {
  id: string
  digest: string
  runId: string
  botId: string
  action: { tool: ComputerTool; x?: number; y?: number; text?: string; rect?: ScreenRect }
  /** e.g. 点击「登录」: short, from the operation. */
  summary: string
  expiresAt: string
}

export type ComputerState = {
  machine: MachineState
  control: ControlState
  controlledBy?: { userId: string }
  lastAction?: LastAction
  pendingApproval?: ApprovalView
}

export type ViewerMode = 'view' | 'control'
export type ViewerGrant = { url: string; expiresAt: string }

export type ApprovalDecision = { digest: string; decision: 'approve' | 'deny'; scope: 'once' | 'run' }

/** One computer task in a conversation: the `data-computer` run event. */
export type ComputerTaskState = 'working' | 'approval' | 'done' | 'failed'
export type ComputerTask = { botId: string; runId: string; task: string; state: ComputerTaskState; approvalId?: string }

/** Workspace-wide pushes from GET /api/computer/events. */
export type ComputerEvent =
  | { type: 'computer.machine'; state: MachineState }
  | { type: 'computer.control'; botId: string; control: ControlState; controlledBy?: { userId: string } }
  | { type: 'computer.action'; botId: string; lastAction: LastAction }
  | { type: 'computer.approval'; botId: string; approval: ApprovalView | null }

/** A host the 添加设备 dialog offers: from the user's ~/.ssh/config or their Tailnet. */
export type KnownHost = { alias: string; hostName?: string; user?: string; source: 'ssh' | 'tailnet'; configured: boolean }

export type SetupStep = 'login' | 'check' | 'install' | 'start' | 'connect'
export type SetupStepState = 'idle' | 'active' | 'done' | 'failed'
export const SETUP_STEPS: SetupStep[] = ['login', 'check', 'install', 'start', 'connect']
