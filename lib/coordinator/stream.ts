import type { ModelCallStreamPart } from '@ai-sdk/workflow'

export type CoordinatorWorkflowStreamPart = ModelCallStreamPart
  | { type: 'coordinator-turn-start'; id: string; quietEligible: boolean }
  /** 停止 cut turn `id` short: what streamed before it is the reply's last words (lib/coordinator/stop.ts). */
  | { type: 'coordinator-turn-stopped'; id: string }
  | { type: 'coordinator-turn-committed'; id: string; through: number; quiet: boolean }

export type CoordinatorStreamEvent =
  | { type: 'start'; id: string }
  | { type: 'text'; id: string; delta: string }
  | { type: 'reset'; id: string; text: string }
  | { type: 'committed'; id: string; through: number; quiet: boolean }
  | { type: 'error' }
