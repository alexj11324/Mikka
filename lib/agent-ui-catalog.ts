import { createLibrary, defineComponent, type ComponentRenderer, type DefinedAction } from '@openuidev/react-lang'
import { openuiLibrary } from '@openuidev/react-ui/genui-lib'
import { z } from 'zod/v4'

const text = z.string().max(8000)
const children = z.array(z.any()).max(30)

export const agentComponentCatalog = {
  BeCard: {
    description: 'beUI Card 紧凑内容卡片。用于有标题的建议、说明或内容分组，children 可嵌套已注册组件；description 可选。图文推荐使用 BeImageCard，不用普通内容卡片代替详细正文。',
    props: z.object({ title: z.string().min(1).max(120), children, description: text.optional() }),
  },
  BeCardGrid: {
    description: '紧凑推荐卡片网格。children 为 1–6 个 BeImageCard，按回答区实际宽度自动排为 1、2 或 3 列，不按整个浏览器宽度判断。多个景点、酒店、地点或其他视觉推荐默认使用此网格，不要把多张 BeImage 纵向堆成大图。先输出网格引用，再逐张定义卡片，以便流式展示。',
    props: z.object({ children: children.min(1).max(6) }),
  },
  BeImageCard: {
    description: '紧凑图文推荐卡片，包含 16:9 小图、标题、标签和简介。title 为对象名称；query 为准确英文图片检索词而非 URL；description 为实质简介；tags 可选，最多 3 个短标签；prompt 可选，必须是携带完整上下文的继续了解问题，点击后在回答区直接继续，不触碰输入框。不伪造预订、收藏、评分或实时价格。图片异步检索，来源和许可可展开，不阻塞文字。搭配 BeCardGrid 使用。',
    props: z.object({
      title: z.string().min(1).max(120),
      query: z.string().trim().min(2).max(160).refine(value => !/[\r\n<>]/.test(value) && !/https?:\/\//i.test(value)),
      description: z.string().min(1).max(800),
      tags: z.array(z.string().min(1).max(40)).max(3).optional(),
      prompt: z.string().min(1).max(4000).optional(),
    }),
  },
  BeImage: {
    description: '单张正文资料配图，不是推荐卡片。仅适合单一主题的文章插图或用户明确要求大图时使用；多个景点、酒店、地点推荐应优先用 BeCardGrid + BeImageCard。异步查找 Wikimedia Commons 真实资料配图并展示来源、作者与许可。query 是具体主题检索词，优先使用准确英文名称，不是 URL；alt 为中文替代文字；caption 可选。最多使用 3 张，不阻塞正文，不伪造图片，不表示历史照片已经核实。',
    props: z.object({ query: z.string().trim().min(2).max(160).refine(value => !/[\r\n<>]/.test(value) && !/https?:\/\//i.test(value)), alt: z.string().min(1).max(300), caption: z.string().max(500).optional() }),
  },
  BeButton: {
    description: 'beUI 弹簧动效快捷提问按钮。label 使用“直接提问”或“继续细化”；action 必须是包含完整上下文、可立即发送的独立问题。点击后直接请求 Agent，不填入或清空底部输入框，不执行工作区操作。需要用户补充信息时使用 BeQuestions，不要展示重复的泛化按钮。“填入提问”仅兼容旧输出，实际显示并执行直接提问。',
    props: z.object({ label: z.enum(['直接提问', '继续细化', '填入提问']), action: text, variant: z.enum(['primary', 'secondary', 'ghost', 'outline']).optional() }),
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
    description: '本地 shadcn 快捷提问按钮。label 使用“直接提问”或“继续细化”；prompt 为包含完整上下文的独立问题。点击后直接请求 Agent，不触碰底部提问草稿，不执行或保存工作区操作。“填入提问”仅兼容旧输出，实际执行直接提问。',
    props: z.object({ label: z.enum(['直接提问', '继续细化', '填入提问']), prompt: text, variant: z.enum(['default', 'secondary', 'outline', 'ghost']).optional() }),
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
  { name: '本地内容与兼容组件', components: ['BeCard', 'BeCardGrid', 'BeImageCard', 'BeImage', 'ShadcnCard', 'ShadcnBadge', 'ShadcnAlert', 'ShadcnAccordion', 'ShadcnTabs', 'ShadcnTable', 'ShadcnButton', 'ReuiBadge', 'ReuiAlert', 'ReuiFrame'], notes: ['复用已安装的本地 shadcn 与 REUI 内容组件。beUI CodeBlock、FileDiff、ToolResult、AgentActivity、Citations、ImageGeneration 已安装，仅在有真实数据的宿主流程中使用，不自动生成虚构工具记录。'] },
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
