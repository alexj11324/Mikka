import { createParser } from '@openuidev/lang-core'
import spec from './agent-ui.spec.json'
import { normalizeAgentUISource } from './agent-ui-source'

// Schema only: do not import a live renderer, action handler, device client or library functions.
const parser = createParser(spec.library.schema, spec.library.root)
const omitted = new Set(['action', 'prompt', 'context', 'variant', 'className', 'size', 'botId', 'runId', 'id', 'precision'])
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const fence = (code: string) => '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(match => match[0].length + 1)))

/** Project every saved panel into text, never instantiate its controls or live ComputerCard. */
export function legacyChatContent(response: string): { format: 'markdown' | 'source'; text: string } {
  if (!/(?:^|\n)\s*root\s*=/.test(response)) return { format: 'markdown', text: response }
  try {
    const parsed = parser.parse(normalizeAgentUISource(response))
    if (!parsed.root || parsed.meta.errors.length || parsed.meta.unresolved.length || parsed.meta.incomplete) {
      return { format: 'source', text: response }
    }
    const ancestors = new Set<object>()
    function text(value: unknown): string {
      if (typeof value === 'string' || typeof value === 'number') return String(value)
      if (!value || typeof value !== 'object') return ''
      if (ancestors.has(value)) throw new Error('Cyclic saved content')
      ancestors.add(value)
      try {
        if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n\n')
        if (!record(value)) return ''
        if (value.type === 'element' && record(value.props)) {
          const props = value.props
          if ((value.typeName === 'TaskChip' || value.typeName === 'RunChip') && typeof props.id === 'string') return props.id
          if (value.typeName === 'BeCodeBlock' && typeof props.code === 'string') {
            const marker = fence(props.code)
            return `${marker}\n${props.code}\n${marker}`
          }
          if ((value.typeName === 'ShadcnTable' || value.typeName === 'BeTable') && Array.isArray(props.columns) && Array.isArray(props.rows)) {
            const row = (cells: unknown[]) => `| ${cells.map(cell => text(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`
            return [row(props.columns), row(props.columns.map(() => '---')), ...props.rows.filter(Array.isArray).map(row)].join('\n')
          }
          // Includes ALL Accordion items / Tabs panes and saved ComputerCard captions.
          return text(props)
        }
        return Object.entries(value).filter(([key]) => !omitted.has(key) && !/^on[A-Z]/.test(key))
          .map(([, item]) => text(item)).filter(Boolean).join('\n\n')
      } finally { ancestors.delete(value) }
    }
    return { format: 'markdown', text: text(parsed.root) }
  } catch {
    // Even malformed historical data stays readable; it never becomes executable JSX.
    return { format: 'source', text: response }
  }
}
