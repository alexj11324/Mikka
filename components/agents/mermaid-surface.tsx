'use client'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CodeBlock } from './code-block'
import type { SanitizedMermaidSvg } from '@/lib/agent-mermaid'

export function MermaidSurface({ svg, source }: { svg: SanitizedMermaidSvg; source: string }) {
  return <figure aria-label="Mermaid 图表" className="m-0 flex max-w-full flex-col gap-3 overflow-x-auto rounded-lg bg-card p-4" tabIndex={0}>
    <div data-agent-mermaid className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
    <figcaption className="sr-only">Mermaid 图表</figcaption>
    <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>查看图表源码</CollapsibleTrigger><CollapsibleContent><CodeBlock code={source} language="text" /></CollapsibleContent></Collapsible>
  </figure>
}
