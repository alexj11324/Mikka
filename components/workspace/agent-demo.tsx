'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { ReasoningText } from '@/components/agents/loading-states/reasoning-text'
import { AGENT_DEMO_CITATIONS, AGENT_DEMO_CODE, AGENT_DEMO_SECTIONS } from '@/lib/agent-demo'
import { AgentCitationsContext } from './agent-citations'
import { AgentCodeBlock } from './agent-code-block'
import { AgentGenerativeUI } from './agent-generative-ui'
import { AgentInteractionContext } from './agent-interaction'
import { AgentImagePreviewContext } from './agent-image'
import { AgentDemoTools } from './agent-demo-tools'
import { withBasePath } from '@/lib/base-path'

const demoCitations = { sources: AGENT_DEMO_CITATIONS, previews: {}, onOpenIssue: () => {} }

const previewImage = { src: withBasePath('/placeholder.svg?height=360&width=640'), width: 640, height: 360, source: 'demo-placeholder', title: '本地演示占位图', author: '', license: '演示专用' }

export function AgentDemo({ onClose }: { onClose: () => void }) {
  const [run, setRun] = useState(0)
  const [feedback, setFeedback] = useState('点击确认、提问或追问按钮，即可看到本地反馈。')
  return <section aria-label="Agent 组件演示" className="orvilo-agent flex size-full min-h-0 flex-col">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 px-4 py-2">
      <SidebarTrigger aria-label="展开或收起侧边栏" />
      <h1 className="text-sm font-medium">Agent 综合演示</h1>
      <Badge variant="secondary">不调用模型</Badge>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => { setRun(value => value + 1); setFeedback('演示已重置，可以重新体验所有交互。') }}><RotateCcw data-icon="inline-start" />重播演示</Button>
        <Button variant="ghost" size="sm" onClick={onClose}><ArrowLeft data-icon="inline-start" />返回对话</Button>
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto" data-agent-demo>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-8 sm:px-6" key={run}>
        <div className="flex flex-col gap-3">
          <h2 className="text-2xl font-semibold">一次看全回复与交互效果</h2>
          <p className="text-sm leading-6 text-muted-foreground">全部内容自动渲染，数据均为虚构样例。演示不会请求模型、读取真实项目或保存任何修改；返回后原对话和草稿仍然保留。</p>
          <div role="group" aria-label="演示内容" className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <a href="#demo-motion" className="underline underline-offset-4">加载与流式代码</a>
            {AGENT_DEMO_SECTIONS.map(section => <a key={section.id} href={`#demo-${section.id}`} className="underline underline-offset-4">{section.title}</a>)}
            <a href="#demo-tools" className="underline underline-offset-4">工具展示</a>
          </div>
        </div>
        <section id="demo-motion" aria-label="加载与流式代码" className="flex scroll-mt-4 flex-col gap-5">
          <h2 className="text-lg font-semibold">Reasoning Text 与流式 Code Block</h2>
          <p className="text-sm text-muted-foreground">beUI 原组件：三种文字动效、语法高亮、行号、重点行、滚动跟随和复制反馈。</p>
          <div className="grid gap-5 rounded-xl border p-4 sm:grid-cols-3">
            {(['cascade', 'swap', 'scramble'] as const).map(variant => <div key={variant} className="flex min-w-0 flex-col gap-2"><h3 className="text-xs text-muted-foreground">{variant}</h3><ReasoningText variant={variant} phrases={['正在准备回复', '正在整理内容']} /></div>)}
          </div>
          <DemoStreamingCode />
        </section>
        <AgentImagePreviewContext value={previewImage}>
          <AgentInteractionContext value={{ busy: false, continueFromAnswer: async prompt => { setFeedback(`已收到演示交互：${prompt}（仅本地反馈，未发送到模型）`); return true } }}>
            {AGENT_DEMO_SECTIONS.map(section => <section key={section.id} id={`demo-${section.id}`} aria-label={section.title} className="flex min-w-0 scroll-mt-4 flex-col gap-4">
              <div className="flex flex-col gap-1"><h2 className="text-lg font-semibold">{section.title}</h2><p className="text-sm text-muted-foreground">{section.description}</p></div>
              <AgentCitationsContext value={section.id === 'citations' ? demoCitations : null}>
                <AgentGenerativeUI response={section.response} isStreaming={false} onAction={event => setFeedback(`已收到演示动作：${event.humanFriendlyMessage || event.type}（未请求模型）`)} />
              </AgentCitationsContext>
            </section>)}
          </AgentInteractionContext>
        </AgentImagePreviewContext>
        <section id="demo-tools" aria-label="工具展示" className="flex min-w-0 scroll-mt-4 flex-col gap-4"><h2 className="text-lg font-semibold">工具、文件差异与来源展示</h2><AgentDemoTools /></section>
      </div>
    </div>
    <footer className="shrink-0 bg-muted px-4 py-3"><p role="status" className="mx-auto max-h-20 max-w-3xl overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{feedback}</p></footer>
  </section>
}

function DemoStreamingCode() {
  const [length, setLength] = useState(0)
  const complete = length >= AGENT_DEMO_CODE.length
  useEffect(() => {
    if (complete) return
    const timer = window.setInterval(() => setLength(value => Math.min(value + 18, AGENT_DEMO_CODE.length)), 140)
    return () => window.clearInterval(timer)
  }, [complete])
  return <AgentCodeBlock filename="demo.ts" language="typescript" code={AGENT_DEMO_CODE.slice(0, length)} isStreaming={!complete} highlightLines={[4, 8]} />
}
