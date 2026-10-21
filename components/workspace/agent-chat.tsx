'use client'

import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentConversation } from './agent-conversation'

export function AgentChat({ question, response, composer, starters, streaming, onReset }: {
  question: string
  response: ReactNode
  composer: ReactNode
  starters: ReactNode
  streaming: boolean
  onReset: () => void
}) {
  return <section id="orvilo-agent" aria-label="有什么可以帮你？" className="flex h-[calc(100svh-4rem)] min-h-0 w-full flex-col bg-background text-foreground">
    <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Agent</h1>
      <Badge variant="secondary">GLM-5.3-Flash</Badge>
      <Tooltip>
        <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="新问题" onClick={onReset} disabled={streaming} />}><Plus aria-hidden="true" /></TooltipTrigger>
        <TooltipContent>清空本轮，开始新问题</TooltipContent>
      </Tooltip>
    </header>
    <AgentConversation question={question} response={response} starters={starters} />
    <footer className="shrink-0 px-4 pt-3 pb-4 sm:px-6 sm:pb-5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {composer}
        <p id="agent-service-note" className="text-center text-xs text-muted-foreground">OpenCode Go · 单次问答，不保存历史，不读取或修改工作区；界面按钮仅填入提问。</p>
      </div>
    </footer>
  </section>
}
