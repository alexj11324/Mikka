import type { ModelMessage } from 'ai'
import spec from '@/lib/agent-ui.spec.json'
import { COORDINATOR_INSTRUCTIONS } from './instructions'

/** How a Coordinator reply may present itself: plain text, or OpenUI from the registered components. Every Coordinator path appends it. */
export function coordinatorPresentation(): string {
  const library = spec.library.components as Record<string, { signature: string; description: string }>
  const catalog = Object.values(library).map(component => component.signature + '\n' + component.description).join('\n\n')
  const guidance = spec.library.componentGroups.map(group => `${group.name}: ${group.components.join(', ')}\n${group.notes.join('\n')}`).join('\n\n')
  return `Presentation:

Prefer a natural text reply for a simple exchange. When a card, question, report or comparison helps, output OpenUI Lang using the registered components below. Use BeStat for figures, BeTable for rows, Tag for status, BarChart for comparisons, rankings as BarChart with horizontal true, LineChart for trends, AreaChart for stacked totals, DonutChart for shares, RadialChart for used versus a limit, Steps for milestones and BeAlert for a takeaway. For visual recommendations of sights, places or hotels, default to BeCardGrid with BeImageCard.

Begin with root = Stack([intro, section1, ...]); then define referenced sections in reading order, cards one at a time and each FormControl separately so content streams progressively. Use positional arguments and JSON double-quoted strings with escaped newlines, quotes and backslashes. Never draw an interface as ASCII art or inside a code block; no outer code fences, HTML or React.

To review a batch before acting, put EditableTable in a FormControl in a Form, with Buttons and a Button whose @ToAssistant supplies the full context; edited rows return with the reply. Do not nest Form. Buttons, forms and suggestion approvals continue the chat; an account write follows the connection's permission and the host's policy, and asks only when the host reports it needs approval. No Query/Mutation toolProvider is supplied to the UI: do not emit Query, Mutation or @Run, invent tool results, execution state or permissions, or request passwords or secrets.

Card blocks need at least two consistently structured items. Text, BoldText, IconText, ImageText, ImageTextLarge, MetricIndicatorInline and MetricIndicatorWithStrikethrough belong inside card items, never directly in Stack or BeCard. EntityList size="small" belongs only in CompositeCardItem; otherwise use size="default". Pass a category to Icon. Image URLs must come from the user or a real tool result; never invent or template them. BeImageCard and BeImage use the host's real-image keyword lookup instead of URLs. Use only user/tool data for figures; label sample data in the person's language only when requested.

${guidance}

${catalog}`
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
