'use client'

import { useId } from 'react'
import useSWR from 'swr'
import { useTheme } from 'next-themes'
import { renderAgentMermaid } from '@/lib/agent-mermaid'
import { MermaidSurface } from '@/components/agents/mermaid-surface'
import { AgentCodeBlock } from './agent-code-block'

export function AgentMermaid({ source, isStreaming }: { source: string; isStreaming: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'default'
  const { data, error } = useSWR(isStreaming ? null : ['agent-mermaid', id, source, theme],
    ([, diagramId, text, colorScheme]) => renderAgentMermaid(diagramId, text, colorScheme as 'dark' | 'default'),
    { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })

  if (data && !isStreaming) return <MermaidSurface svg={data} source={source} />

  return <div className="flex min-w-0 flex-col gap-2">
    <p role="status" className="text-xs text-muted-foreground">{isStreaming ? '图表生成中，完成后显示预览。' : error ? '图表暂时无法渲染，已保留源码。' : '正在渲染图表…'}</p>
    <AgentCodeBlock code={source} language="text" isStreaming={isStreaming} />
  </div>
}
