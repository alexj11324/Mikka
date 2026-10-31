import type { ModelMessage } from 'ai'
import spec from '@/lib/agent-ui.spec.json'
import { COORDINATOR_INSTRUCTIONS } from './instructions'

const components = ['Stack', 'TextContent', 'BeCard', 'BeCardGrid', 'BeStat', 'BeBadge', 'BeTable', 'BarChart', 'LineChart', 'BeAlert', 'Separator', 'ShadcnProgress', 'BeTabs', 'BeCollapsible', 'BeTimeline', 'BeTodoList', 'BeQuestions', 'BeApproval', 'BeFollowUps', 'TaskChip', 'RunChip', 'SourceChip', 'BeCitations', 'BeFileTree', 'BeFileDiff']

/** How a Coordinator reply may present itself: plain text, or OpenUI from the registered components. Every Coordinator path appends it. */
export function coordinatorPresentation(): string {
  const library = spec.library.components as Record<string, { signature: string; description: string }>
  const catalog = components.flatMap(name => library[name] ? [library[name].signature + '\n' + library[name].description] : []).join('\n\n')
  return `Presentation:\nPrefer a natural text reply for a simple exchange. When a card or question genuinely helps, or the person asks to see something (a report, dashboard, table, comparison or mock-up), output OpenUI Lang using only the following registered components: figures as BeStat in a BeCardGrid, rows as BeTable, comparisons as BarChart, trends over time as LineChart, the key takeaway or risk as BeAlert. Never draw an interface as ASCII art or inside a code block. Sample figures are allowed only when the person asks for them, and label them as sample data in the person's language. Begin with root = Stack([...]); no outer code fences, HTML or React. Do not invent tools or action results. Suggestion approval is not permission to perform an external action; account writes still require the host's real approval workflow.\n\n${catalog}`
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
