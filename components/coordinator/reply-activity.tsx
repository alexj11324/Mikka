'use client'

import { memo } from 'react'
import { useTranslations } from 'next-intl'
import { Check, ChevronRight, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { TextShimmer } from '@/components/motion/text-shimmer'
import type { ChatTool } from '@/lib/coordinator/context'

/**
 * What a reply did before its words, in order: whether it thought, then each tool it used with how it stands.
 * `thinking` is live only: `active` while the model thinks, else the seconds it took. A stored reply knows
 * only that it thought (`thought`), never for how long or what (chat-projection.ts).
 * A tool's input and output previews open under it; they are already short and masked.
 */
export const ReplyActivity = memo(function ReplyActivity({ tools, thinking, thought = false }: {
  tools: readonly ChatTool[]
  thinking?: { active: boolean; seconds: number }
  thought?: boolean
}) {
  const t = useTranslations('Coordinator.activity')
  if (!tools.length && !thinking && !thought) return null
  const label = (name: string) => t.has(`tools.${name}` as never) ? t(`tools.${name}` as never) : t('tool')
  return <div data-reply-activity="" className="flex w-full min-w-0 flex-col items-start gap-0.5 text-xs text-muted-foreground">
    {thinking
      ? <p data-activity-thinking={thinking.active ? 'active' : 'done'} className="flex h-6 items-center">
          {thinking.active ? <TextShimmer>{t('thinking')}</TextShimmer> : t('thought', { seconds: thinking.seconds })}
        </p>
      : thought && <p data-activity-thinking="stored" className="flex h-6 items-center">{t('thoughtStored')}</p>}
    {tools.map(tool => {
      const name = label(tool.name)
      const status = tool.state === 'running'
        ? <Spinner aria-label={t('state.running')} className="size-3" />
        : tool.state === 'done'
          ? <Check role="img" aria-label={t('state.done')} className="size-3 text-success" />
          : <CircleAlert role="img" aria-label={t('state.error')} className="size-3 text-destructive" />
      const title = <>{status}{tool.state === 'running' ? <TextShimmer>{name}</TextShimmer> : <span>{name}</span>}</>
      // Nothing to open: the row is the tool's name and state only.
      if (!tool.input && !tool.output) return <p key={tool.call} data-activity-tool={tool.state} className="flex h-6 items-center gap-1.5">{title}</p>
      return <Collapsible key={tool.call} data-activity-tool={tool.state} className="flex w-full min-w-0 flex-col items-start">
        <CollapsibleTrigger render={<Button type="button" variant="ghost" size="xs" className="group/tool -ml-2 gap-1.5 font-normal text-muted-foreground" />}>
          {title}
          <ChevronRight aria-hidden="true" data-icon="inline-end" className="transition-transform group-data-[panel-open]/tool:rotate-90 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent className="w-full min-w-0">
          <dl className="ml-4.5 flex max-w-md flex-col gap-1 border-l border-border py-1 pl-3">
            {tool.input && <div><dt>{t('input')}</dt><dd className="font-mono break-all whitespace-pre-wrap text-foreground/80">{tool.input}</dd></div>}
            {tool.output && <div><dt>{t('output')}</dt><dd className="font-mono break-all whitespace-pre-wrap text-foreground/80">{tool.output}</dd></div>}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    })}
  </div>
})
