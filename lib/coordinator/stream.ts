import type { ModelCallStreamPart } from '@ai-sdk/workflow'

export type CoordinatorWorkflowStreamPart = ModelCallStreamPart
  | { type: 'coordinator-turn-start'; id: string; quietEligible: boolean }
  | { type: 'coordinator-turn-committed'; id: string; through: number; quiet: boolean }

export type CoordinatorStreamEvent =
  | { type: 'start'; id: string }
  | { type: 'text'; id: string; delta: string }
  | { type: 'reset'; id: string; text: string }
  | { type: 'committed'; id: string; through: number; quiet: boolean }
  | { type: 'error' }
