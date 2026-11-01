'use client'

import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type StepNode = { props?: { title?: unknown; details?: unknown } }

/**
 * OpenUI's `Steps` with its own schema, drawn by the host: OpenUI greys the
 * title and sets the details in body black, so the reader met the secondary
 * line first. Title Medium in the foreground, details Regular muted, both on a
 * 20px line (R-32; ui-policy allows no 13px step in business code).
 */
export function AgentSteps({ props }: { props: { items?: StepNode[] } }) {
  const items = props.items ?? []
  return <ol className="flex min-w-0 flex-col">
    {items.map((item, index) => {
      const title = typeof item?.props?.title === 'string' ? item.props.title : ''
      const details = typeof item?.props?.details === 'string' ? item.props.details : ''
      return <li key={index} className="group/step flex min-w-0 gap-3">
        <div className="flex flex-col items-center">
          <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground">{index + 1}</span>
          <span aria-hidden="true" className="w-px flex-1 bg-border group-last/step:hidden" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1 pb-4 group-last/step:pb-0">
          <span className="text-sm leading-5 font-medium text-foreground">{title}</span>
          {details && <div className="min-w-0 break-words text-sm leading-5 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
            <Markdown remarkPlugins={[remarkGfm]} skipHtml>{details}</Markdown>
          </div>}
        </div>
      </li>
    })}
  </ol>
}
