import { ClipboardList, FileText, GitCompareArrows, Layers } from 'lucide-react'

export const agentStarters = [
  { title: '拆解项目计划', icon: Layers, prompt: '帮我把一个新项目拆解成清晰的阶段、交付物和可执行任务。' },
  { title: '整理任务清单', icon: ClipboardList, prompt: '帮我整理接下来要做的事，按优先级生成一份任务清单。' },
  { title: '起草项目周报', icon: FileText, prompt: '帮我起草一份项目周报，包含本周进展、风险和下周计划。' },
  { title: '比较实施方案', icon: GitCompareArrows, prompt: '帮我从成本、复杂度和可维护性三个方面比较实施方案。' },
]
