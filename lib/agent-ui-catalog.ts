import { createLibrary, defineComponent, type ComponentRenderer, type DefinedAction } from '@openuidev/react-lang'
import { openuiLibrary } from '@openuidev/react-ui/genui-lib'
import { z } from 'zod/v4'

const text = z.string().max(8000)
const children = z.array(z.any()).max(30)

export const agentComponentCatalog = {
  BeButton: {
    description: 'beUI 弹簧动效按钮。label 为“填入提问”或“继续细化”；action 必须是包含上下文的完整独立问题。只填入提问，不自动发送或保存。',
    props: z.object({ label: z.enum(['填入提问', '继续细化']), action: text, variant: z.enum(['primary', 'secondary', 'ghost', 'outline']).optional() }),
  },
  BeBadge: {
    description: 'beUI 动效状态徽标。只展示用户提供的状态或明确标注的建议，不表示执行了工作区操作。',
    props: z.object({ text: z.string().min(1).max(80), status: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'loading']).optional() }),
  },
  BeStat: {
    description: 'beUI 动态数字指标。label 为指标名，value 必须来自用户提供的数据，unit 为单位，precision 为小数位数。不编造数据、不读取工作区。',
    props: z.object({ label: z.string().min(1).max(80), value: z.number().min(-1e12).max(1e12), unit: z.string().max(12).optional(), precision: z.number().int().min(0).max(4).optional() }),
  },
  ShadcnCard: {
    description: '本地 shadcn 卡片。用于有标题的建议、说明或内容分组，可嵌套已注册组件。',
    props: z.object({ title: text, children, description: text.optional() }),
  },
  ShadcnBadge: {
    description: '本地 shadcn 简短状态标签。',
    props: z.object({ text, variant: z.enum(['default', 'secondary', 'outline', 'destructive']).optional() }),
  },
  ShadcnAlert: {
    description: '本地 shadcn 提示说明。只能展示信息，不表示执行了操作。',
    props: z.object({ title: text, description: text, variant: z.enum(['default', 'destructive']).optional() }),
  },
  ShadcnProgress: {
    description: '本地 shadcn 进度条。只使用用户提供的百分比，不编造工作区进度。',
    props: z.object({ label: text, value: z.number().min(0).max(100) }),
  },
  ShadcnAccordion: {
    description: '本地 shadcn 折叠说明列表。items 中每项包含 title 和 content 文本。',
    props: z.object({ items: z.array(z.object({ title: text, content: text })).max(10), multiple: z.boolean().optional() }),
  },
  ShadcnTabs: {
    description: '本地 shadcn 标签页。items 中每项包含 title 和 children 组件数组。',
    props: z.object({ items: z.array(z.object({ title: text, children })).max(6) }),
  },
  ShadcnTable: {
    description: '本地 shadcn 表格。columns 为列名数组，rows 为二维文本数组。最多 6 列、30 行。',
    props: z.object({ columns: z.array(text).min(1).max(6), rows: z.array(z.array(text).max(6)).max(30) }),
  },
  ShadcnButton: {
    description: '本地 shadcn 按钮。label 必须为“填入提问”或“继续细化”；prompt 为完整独立的问题。只填入输入框，不自动请求或保存。',
    props: z.object({ label: z.enum(['填入提问', '继续细化']), prompt: text, variant: z.enum(['default', 'secondary', 'outline', 'ghost']).optional() }),
  },
  ReuiBadge: {
    description: '本地 REUI 语义状态徽标，可用不同状态颜色。',
    props: z.object({ text, variant: z.enum(['outline', 'secondary', 'primary-light', 'info-light', 'success-light', 'warning-light', 'destructive-light']).optional() }),
  },
  ReuiAlert: {
    description: '本地 REUI 语义提示。不表示已保存、已更新或执行了任何工作区操作。',
    props: z.object({ title: text, description: text, variant: z.enum(['default', 'info', 'success', 'warning', 'destructive']).optional() }),
  },
  ReuiFrame: {
    description: '本地 REUI 分组面板。标题及说明位于面板上方，children 为已注册组件。',
    props: z.object({ title: text, children, description: text.optional() }),
  },
} as const

export type AgentComponentName = keyof typeof agentComponentCatalog
export type AgentComponentRenderers = {
  [Name in AgentComponentName]: ComponentRenderer<z.infer<(typeof agentComponentCatalog)[Name]['props']>>
}

export function createAgentLibrary(renderers: Partial<AgentComponentRenderers> = {}) {
  const names = Object.keys(agentComponentCatalog) as AgentComponentName[]
  const components = names.map(name => {
    const definition = agentComponentCatalog[name]
    return defineComponent({
      name,
      ...definition,
      component: (renderers[name] ?? (() => null)) as ComponentRenderer<z.infer<typeof definition.props>>,
    })
  })
  const extended = openuiLibrary.extend({ components: { add: components } })
  return createLibrary({
    root: 'Stack',
    components: Object.values(extended.components),
    functions: Object.values(extended.functions),
    actions: Object.values(extended.actions) as DefinedAction[],
    componentGroups: [
      { name: 'beUI', components: ['BeButton', 'BeBadge', 'BeStat'], notes: ['优先使用 beUI 按钮、状态徽标和数字指标；数字只能来自用户输入。'] },
      { name: '本地内容组件', components: names.filter(name => !name.startsWith('Be')), notes: ['使用本地 shadcn 与 REUI 组件组织内容。'] },
    ],
  })
}
