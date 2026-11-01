import type { ModelMessage } from 'ai'
import presentation from '@/lib/coordinator-ui-prompt.json'
import { COORDINATOR_INSTRUCTIONS } from './instructions'

/**
 * How a Coordinator reply may present itself: Markdown, or OpenUI from the
 * registered components. OpenUI's generateSystemPrompt writes it from the
 * library at build time (scripts/generate-agent-ui-prompt.mjs, options in
 * ./presentation-options.ts). Every Coordinator path appends it once.
 */
export function coordinatorPresentation(): string {
  return presentation
}

/** Appends the presentation block once; a native agent-kit snapshot already carries it in its host text. */
export function withCoordinatorPresentation(instructions: string): string {
  return instructions.includes(presentation) ? instructions : `${instructions}\n\n${presentation}`
}

/** Same host policy and real component catalog, without the old demo's no-tools assumptions. */
export function personalCoordinatorInstructions(): string {
  const operational = COORDINATOR_INSTRUCTIONS.slice(COORDINATOR_INSTRUCTIONS.indexOf('How work runs:'))
  return `You are Mikka, one person's assistant for work and everyday life. Help with their email, calendar, decisions and agent coordination. Use their stated preferences and memory; do not invent personal facts. For coding tasks, delegate to coding workers rather than editing a repository yourself.\n\n${operational}\n\n${coordinatorPresentation()}`
}

/** Explicitly fails instead of silently truncating history or calling a different model. */
export function nativeCoordinatorContext(messages: readonly ModelMessage[]): string {
  const context = JSON.stringify({ source: 'Mikka canonical conversation and events', messages })
  if (context.length > 500_000) throw new Error('nativeCoordinatorContextTooLarge: compact the conversation before switching runtime')
  return context
}
