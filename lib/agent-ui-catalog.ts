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
  BeResponse: {
    description: '对应 AI Elements MessageResponse 的 beUI 回复内容分组。children 为已注册内容组件，流式状态由宿主控制，不自行模拟生成进度。',
    props: z.object({ children }),
  },
  BeApproval: {
    description: '对应 AI Elements Confirmation 的 beUI ApprovalCard，用于确认建议方案，不是工具授权。title 和 description 必须完整描述待确认建议；context 包含完整上下文。用户在卡片内确认、拒绝或要求修改后，直接提交意见并继续对话，不经输入框；不授权或执行工作区操作。',
    props: z.object({ title: z.string().min(1).max(200), description: text, context: z.string().min(1).max(4000) }),
  },
  BeQuestions: {
    description: 'beUI ApprovalCard 提问模式，支持单选、多选、自定义回答和多步骤问题。context 必须包含完整任务背景。每个问题和选项的 id/value 必须唯一。用户在卡片内提交回答后直接继续对话，不经输入框；保留失败重试，不得索取密码或密钥。',
    props: z.object({
      context: z.string().min(1).max(4000),
      questions: z.array(z.object({
        id: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        options: z.array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(200), description: z.string().max(300).optional() })).min(1).max(6).optional(),
        multiple: z.boolean().optional(),
        allowCustom: z.boolean().optional(),
      }).refine(question => Boolean(question.options?.length || question.allowCustom), '问题必须提供选项或允许自定义回答')
        .refine(question => new Set(question.options?.map(option => option.value)).size === (question.options?.length ?? 0), '选项值不可重复'))
        .min(1).max(10).refine(questions => new Set(questions.map(question => question.id)).size === questions.length, '问题 ID 不可重复'),
    }),
  },
  BeTodoList: {
    description: '对应 AI Elements Plan/Task 的 beUI TodoList。source=suggestion 为建议计划，所有项目强制显示待开始，不代表执行；source=user 仅展示用户本次明确提供的真实状态和进度。不能编造工具执行进度。',
    props: z.object({
      title: z.string().min(1).max(120),
      items: z.array(z.object({ id: z.string().min(1).max(80), title: z.string().min(1).max(200), status: z.enum(['pending', 'in-progress', 'completed', 'cancelled']).optional(), progress: z.number().min(0).max(100).optional(), detail: z.string().max(300).optional() })).min(1).max(20)
        .refine(items => new Set(items.map(item => item.id)).size === items.length, '任务 ID 不可重复'),
      source: z.enum(['suggestion', 'user']).optional(),
    }),
  },
  AgentIcon: {
    description: '现有 Lucide 图标白名单，不是 beUI 独立图标包。用于带中文含义的状态说明，不能传入 SVG、组件代码、路径或任意图标名。',
    props: z.object({ name: z.enum(['assistant', 'reply', 'approve', 'question', 'progress', 'task', 'code', 'source']), label: z.string().min(1).max(80) }),
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

export const agentComponentGroups: { name: string; components: AgentComponentName[]; notes: string[] }[] = [
  { name: '消息回复', components: ['BeResponse'], notes: ['AI Elements MessageResponse → beUI StreamingResponse；回复正文可嵌套已注册组件。会话和输入框由宿主控制，不由模型创建。'] },
  { name: '审批与问题', components: ['BeApproval', 'BeQuestions'], notes: ['Confirmation → ApprovalCard；选择问题复用 ApprovalCard 提问模式。在回答区直接提交并继续对话，不执行工具、不持久保存审批。ToolApproval 已安装但仅供未来真实工具授权流程使用，不开放给模型伪造授权。'] },
  { name: '任务与进度', components: ['BeTodoList', 'BeStat', 'ShadcnProgress'], notes: ['Plan/Task → TodoList；Loader/Shimmer → AgentProgress、ReasoningText、ThinkingShimmer，由宿主根据请求状态控制。建议计划保持待开始；数字只能来自用户输入。'] },
  { name: '图标状态与操作', components: ['AgentIcon', 'BeBadge', 'BeButton'], notes: ['Lucide 提供图标；beUI AnimatedBadge 提供动态状态图标；Button 提供操作反馈。不得用动态图标伪造执行结果。'] },
  { name: '本地内容与兼容组件', components: ['ShadcnCard', 'ShadcnBadge', 'ShadcnAlert', 'ShadcnAccordion', 'ShadcnTabs', 'ShadcnTable', 'ShadcnButton', 'ReuiBadge', 'ReuiAlert', 'ReuiFrame'], notes: ['复用已安装的本地 shadcn 与 REUI 内容组件。beUI CodeBlock、FileDiff、ToolResult、AgentActivity、Citations、ImageGeneration 已安装，仅在有真实数据的宿主流程中使用，不自动生成虚构工具记录。'] },
]

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
    componentGroups: agentComponentGroups,
  })
}
