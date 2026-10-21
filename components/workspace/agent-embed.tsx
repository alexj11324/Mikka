'use client'

import { useState } from 'react'
import { ExternalLink, RotateCw } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'

const OPENUI_URL = 'https://www.openui.com/demo/intelligent-ui'

export function AgentEmbed() {
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')

  function reload() {
    setStatus('loading')
    setRevision(value => value + 1)
  }

  return <section aria-labelledby="agent-title" className="flex h-[calc(100svh-4rem)] min-h-96 w-full flex-col">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 id="agent-title" className="text-sm font-semibold">Open Intelligent UI</h1>
        <p className="text-xs text-muted-foreground">在 Agent 中使用 OpenUI 交互界面</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={reload} aria-label="重新加载 Agent 界面"><RotateCw data-icon="inline-start" />重新加载</Button>
        <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={OPENUI_URL} target="_blank" rel="noopener noreferrer"><ExternalLink data-icon="inline-start" />独立打开<span className="sr-only">（新标签页）</span></a>
      </div>
    </header>
    <iframe
      key={revision}
      title="Open Intelligent UI 交互界面"
      src={OPENUI_URL}
      className="min-h-0 w-full flex-1 border-0 bg-background"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      allow="clipboard-write"
      referrerPolicy="no-referrer"
      onLoad={() => setStatus('loaded')}
      onError={() => setStatus('error')}
    />
    <footer className="flex shrink-0 flex-col gap-1 px-4 py-2 text-xs text-muted-foreground sm:px-6">
      {status === 'loading' && <p role="status">正在加载外部界面…</p>}
      {status === 'error' && <p role="alert" className="text-destructive">界面加载失败，请重新加载或选择独立打开。</p>}
      <p>由 OpenUI 提供的外部演示，未连接 Orvilo 工作区数据。请勿输入敏感信息；若界面未显示，可独立打开。</p>
    </footer>
  </section>
}
