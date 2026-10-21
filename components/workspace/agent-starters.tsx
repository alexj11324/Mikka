'use client'

import { Button } from '@openuidev/react-ui/Button'
import { ClipboardList, FileText, GitCompareArrows, Layers } from 'lucide-react'

const starters = [
  { title: '拆解项目计划', icon: Layers, prompt: '帮我把一个新项目拆解成清晰的阶段、交付物和可执行任务。' },
  { title: '整理任务清单', icon: ClipboardList, prompt: '帮我整理接下来要做的事，按优先级生成一份任务清单。' },
  { title: '起草项目周报', icon: FileText, prompt: '帮我起草一份项目周报，包含本周进展、风险和下周计划。' },
  { title: '比较实施方案', icon: GitCompareArrows, prompt: '帮我从成本、复杂度和可维护性三个方面比较实施方案。' },
]

export function AgentStarters({ onSelect }: { onSelect: (prompt: string) => void }) {
  return <div role="group" aria-label="快速开始" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    {starters.map(starter => <Button key={starter.title} type="button" variant="secondary" size="large" className="min-h-16 w-full justify-start" iconLeft={<starter.icon aria-hidden="true" />} onClick={() => onSelect(starter.prompt)}>{starter.title}</Button>)}
  </div>
}
