'use client'

import dynamic from 'next/dynamic'
import type { ActionEvent } from '@openuidev/react-lang'
import { Card as OpenUICard } from '@openuidev/react-ui/Card'

const AgentGenerativeUI = dynamic(() => import('./agent-generative-ui').then(module => module.AgentGenerativeUI), {
  ssr: false,
  loading: () => <p role="status" className="text-xs text-muted-foreground">正在加载生成界面…</p>,
})

export function AgentResponse({ completion, error, isLoading, onAction }: { completion: string; error?: Error; isLoading: boolean; onAction: (event: ActionEvent) => void }) {
  if (!completion && !error && !isLoading) return null

  return <section aria-labelledby="agent-response-title" className="min-w-0">
    <OpenUICard width="full">
      <div className="flex min-w-0 flex-col gap-3">
        <h2 id="agent-response-title" className="text-sm font-medium">Agent 回复</h2>
        {isLoading && <p role="status" className="text-xs text-muted-foreground">正在生成回复…</p>}
        {completion && <div aria-busy={isLoading} className="min-w-0 overflow-x-auto break-words">
          <AgentGenerativeUI response={completion} isStreaming={isLoading} onAction={onAction} />
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error.message || '请求失败，请稍后重试。'} 你的输入已保留，可重新发送。</p>}
      </div>
    </OpenUICard>
  </section>
}
