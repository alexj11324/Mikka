// i18n-ignore-file: Model protocol descriptions and validated action literals are not interface copy.
import { createLibrary, defineComponent, type ComponentRenderer, type DefinedAction } from '@openuidev/react-lang'
import { openuiLibrary } from '@openuidev/react-ui/genui-lib'
import { z } from 'zod/v4'

const text = z.string().max(8000)
const children = z.array(z.any()).max(30)
/** At most five series, one per chart token (--chart-1 … --chart-5); every series has one value per label. */
const chart = {
  labels: z.array(z.string().min(1).max(40)).min(1).max(24),
  series: z.array(z.object({ name: z.string().min(1).max(40), values: z.array(z.number().min(-1e12).max(1e12)).max(24) })).min(1).max(5),
}
const seriesMatchLabels = ({ labels, series }: { labels: string[]; series: { values: number[] }[] }) => series.every(item => item.values.length === labels.length)

export const agentComponentCatalog = {
  TextContent: {
    description: '正文富文本。text 支持 Markdown 标题、列表、表格、引用、代码块、LaTeX 数学公式和 mermaid 围栏图表。公式用 $$ 包裹，Mermaid 放在 text 字符串内的 mermaid 代码围栏中。不要把整个 OpenUI 输出包进围栏。',
    props: z.object({ text: z.string(), size: z.enum(['small', 'default', 'large', 'small-heavy', 'large-heavy']).optional() }),
  },
  BeCodeBlock: {
    description: 'beUI CodeBlock 语法高亮代码块，带行号、复制反馈和流式跟随。code 为纯代码字符串；language 为语言名，filename 可选；highlightLines 为需要强调的行号。只展示代码，不执行。Markdown 中的代码围栏也使用同一个 beUI 组件。',
    props: z.object({ code: z.string().max(50000), language: z.string().max(40).optional(), filename: z.string().max(200).optional(), highlightLines: z.array(z.number().int().min(1)).max(100).optional() }),
  },
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
  BeFollowUps: {
    description: '回答末尾的相关追问。items 为 1–3 个有实质帮助的下一步问题，label 直接显示具体问题，prompt 携带必要上下文。只在有价值时提供，不替代当前答案；需要补充关键信息用 BeQuestions。点击直接继续对话，不改变输入草稿。',
    props: z.object({ items: z.array(z.object({ label: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(4000) })).min(1).max(3).refine(items => new Set(items.map(item => item.label)).size === items.length, '追问不可重复') }),
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
    description: 'beUI ApprovalCard 提问模式，支持单选、多选、自定义回答和多步骤问题。context 必须包含完整任务背景。每个问题和选项的 id/value 必须唯一。用户在卡片内提交回答后直接继续对话，不经输入框；保留失败重试，不得索取密码或密钥。只有一个单选问题时显示为 A/B/C/D 选项行，点击的选项文字即用户回复：Factory 任务派发前澄清（intake 路由到 clarify）或派发失败需用户二选一时用它，问题写清楚、选项 2–4 个；task 可选，为工具返回的真实任务 id，宿主在问题前显示任务引用。派发失败的云端选项是在 Mikka Cloud 上运行（云电脑用用户自己的 E2B 密钥），问题写“派不出去：{设备名} 不在线。等它上线，还是在 Mikka Cloud 上运行？”，选项 value 固定为 wait（等它上线）与 cloud（在 Mikka Cloud 上运行），宿主按 value 本地化，不加解释段落；用户未配置 E2B 密钥时该选项设 action:"cloudKeySettings"，宿主显示为去设置密钥的入口，不发送回答。dispatch_run 返回 error=machineUnavailable 时没有电脑能跑这个任务：按 result.card 原样画一个单选问题（title 与 options 原样，每个选项保留 value 和 action），宿主按 action 处理，不加解释段落；用户回答后再调用 dispatch_run。input 可选，用 beUI 控件作答：select 为下拉选择（需 options），switch 为是/否开关，slider 为数值滑块（需 range:{min,max,step?,unit?}），dateRange 为日期区间；未设 input 时单选用 Radio、多选用 Checkbox。',
    props: z.object({
      context: z.string().min(1).max(4000),
      questions: z.array(z.object({
        id: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        options: z.array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(200), description: z.string().max(300).optional(), action: z.enum(['cloudKeySettings', 'enableThisMac', 'connectServer', 'e2bKey', 'allowAutoSchedule', 'serverOnline']).optional() })).min(1).max(6).optional(),
        multiple: z.boolean().optional(),
        allowCustom: z.boolean().optional(),
        input: z.enum(['select', 'switch', 'slider', 'dateRange']).optional(),
        range: z.object({ min: z.number().min(-1e9).max(1e9), max: z.number().min(-1e9).max(1e9), step: z.number().positive().max(1e9).optional(), unit: z.string().max(12).optional() }).refine(range => range.min < range.max, 'min 必须小于 max').optional(),
      }).refine(question => Boolean(question.options?.length || question.allowCustom || question.input === 'switch' || question.input === 'dateRange' || question.input === 'slider'), '问题必须提供选项或允许自定义回答')
        .refine(question => question.input !== 'select' || Boolean(question.options?.length), '下拉选择必须提供选项')
        .refine(question => question.input !== 'slider' || Boolean(question.range), '滑块必须提供 range')
        .refine(question => new Set(question.options?.map(option => option.value)).size === (question.options?.length ?? 0), '选项值不可重复'))
        .min(1).max(10).refine(questions => new Set(questions.map(question => question.id)).size === questions.length, '问题 ID 不可重复'),
      task: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional(),
    }),
  },
  BeTodoList: {
    description: '对应 AI Elements Plan/Task 的 beUI TodoList。source=suggestion 为建议计划，所有项目强制显示���开始，不代表执行；source=user 仅展示用户本次明确提供的真实状态和进度。不能编造工具执行进度。',
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
  InlineText: {
    description: '一段内联正文，parts 依次是文字和 TaskChip / RunChip / SourceChip 引用，chip 跟着文字排版，放不下时整体换行，不单独占一行。只在需要引用任务、运行或网页时使用，其余正文用 TextContent。',
    props: z.object({ parts: z.array(z.any()).min(1).max(40) }),
  },
  TaskChip: {
    description: '内联任务引用：状态点、编号、标题。id 必须是工具返回的真实任务 id，宿主按 id 查出状态、编号和标题，点击打开任务；不要再在旁边重复标题。没有真实任务 id 时不要使用。放在 InlineText 的 parts 里。',
    props: z.object({ id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }),
  },
  RunChip: {
    description: '内联运行引用：Agent 名和 harness 图标，悬停显示状态和所属任务。id 必须是工具返回的真实运行 id；没有时不要使用。放在 InlineText 的 parts 里。',
    props: z.object({ id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }),
  },
  SourceChip: {
    description: '内联网页来源，例如 pull request 或文档。url 为 http(s) 地址，label 为简短名称，可选；悬停显示网页预览。放在 InlineText 的 parts 里。',
    props: z.object({ url: z.string().url().max(2000).refine(value => /^https?:\/\//i.test(value)), label: z.string().min(1).max(80).optional() }),
  },
  ComputerCard: {
    description: '电脑卡片：一句任务和 bot 电脑的实时画面，状态和审批由宿主读取并显示在卡片里。botId、runId 必须是工具返回的真实 id；task 是一句话任务；state 可选，默认 working；thread 可选，是这次运行（线程）的名字，例如「#66 预览部署检查」，不是 bot 名。每个电脑任务只放一张，不要另写步骤清单、操作记录或系统配置。',
    props: z.object({ botId: z.string().min(1).max(80), runId: z.string().min(1).max(80), task: z.string().min(1).max(200), state: z.enum(['working', 'approval', 'done', 'failed']).optional(), botName: z.string().min(1).max(80).optional(), thread: z.string().min(1).max(80).optional() }),
  },
  BeAlert: {
    description: 'beUI 动效提示框，用作报告中的结论、风险或注意事项（callout）。variant 为 default、info、success、warning、destructive。只展示信息，不表示执行了操作。',
    props: z.object({ title: z.string().min(1).max(200), description: text, variant: z.enum(['default', 'info', 'success', 'warning', 'destructive']).optional() }),
  },
  BeTable: {
    description: 'beUI 数据表格，点击表头可排序。columns 为列名，rows 为二维数组，单元格为文本或数字；数字单元格按数值排序。最多 6 列、30 行。',
    props: z.object({ columns: z.array(z.string().min(1).max(80)).min(1).max(6), rows: z.array(z.array(z.union([z.string().max(2000), z.number().min(-1e12).max(1e12)])).max(6)).max(30) }),
  },
  BeTabs: {
    description: 'beUI 标签页。items 中每项包含 title 和 children 组件数组，最多 6 项。',
    props: z.object({ items: z.array(z.object({ title: z.string().min(1).max(40), children })).min(1).max(6) }),
  },
  BeCollapsible: {
    description: 'beUI 动效折叠区，标题常显、children 折叠。只放补充内容，重要结论不要折叠；defaultOpen 可选。',
    props: z.object({ title: z.string().min(1).max(200), children, defaultOpen: z.boolean().optional() }),
  },
  BarChart: {
    description: '柱状图（shadcn chart，颜色来自主题图表色）。labels 为分类，series 为 1–5 组 {name, values}，values 与 labels 等长，最多 24 个分类；horizontal 为 true 时横向，用于排行（分类名长或按大小排列）；unit 为数值单位。数字只能来自用户或工具数据，示例数据须标明。',
    props: z.object({ ...chart, horizontal: z.boolean().optional(), unit: z.string().max(12).optional() }).refine(seriesMatchLabels, 'values 必须与 labels 等长'),
  },
  LineChart: {
    description: '折线图（shadcn chart），用于随时间变化的趋势。labels 为时间点，series 为 1–5 组 {name, values}，values 与 labels 等长，最多 24 个点；unit 为数值单位。数字只能来自用户或工具数据，示例数据须标明。',
    props: z.object({ ...chart, unit: z.string().max(12).optional() }).refine(seriesMatchLabels, 'values 必须与 labels 等长'),
  },
  AreaChart: {
    description: '堆叠面积图（ReUI c-chart-14），用于累计或构成随时间的变化。labels 为时间点，series 为 1–5 组 {name, values}，values 与 labels 等长，最多 24 个点；第一组画在最上层；unit 为数值单位。数字只能来自用户或工具数据，示例数据须标明。',
    props: z.object({ ...chart, unit: z.string().max(12).optional() }).refine(seriesMatchLabels, 'values 必须与 labels 等长'),
  },
  DonutChart: {
    description: '环形图（ReUI c-chart-19），中间显示合计，用于占比。slices 为 2–5 项 {name, value}，value 不能为负；unit 为数值单位；total 为合计下方的短标签（如「合计」）。数字只能来自用户或工具数据，示例数据须标明。',
    props: z.object({ slices: z.array(z.object({ name: z.string().min(1).max(40), value: z.number().min(0).max(1e12) })).min(2).max(5), unit: z.string().max(12).optional(), total: z.string().max(20).optional() }),
  },
  RadialChart: {
    description: '环形进度图（shadcn chart），一条弧表示已用占上限多少，中间显示已用量和上限：额度、预算、完成度。label 为名称，used 为已用量，limit 为上限（大于 0），unit 为单位。数字只能来自用户或工具数据。',
    props: z.object({ label: z.string().min(1).max(40), used: z.number().min(0).max(1e12), limit: z.number().positive().max(1e12), unit: z.string().max(12).optional() }),
  },
  Separator: {
    description: '段落分隔，用于分开报告中的部分。按界面规范显示为留白而不是横线。不带参数。',
    props: z.object({}),
  },
  BeFileTree: {
    description: 'beUI 文件树。paths 为以 / 分隔的相对路径（最多 60 个），宿主自动按目录分组。只展示用户或工具给出的真实路径，或明确标为建议的目录结构。',
    props: z.object({ paths: z.array(z.string().min(1).max(300).refine(value => !value.startsWith('/') && !value.split('/').includes('..') && !/[\r\n<>]/.test(value))).min(1).max(60) }),
  },
  BeCitations: {
    description: 'beUI 引用来源列表。sources 为 1–10 个 {title, url}，url 为 http(s) 地址。只列出本次真正读取过的网页或用户提供的链接，不编造来源；正文内引用单个网页用 SourceChip。',
    props: z.object({ sources: z.array(z.object({ title: z.string().min(1).max(200), url: z.string().url().max(2000).refine(value => /^https?:\/\//i.test(value)) })).min(1).max(10) }),
  },
  BeFileDiff: {
    description: 'beUI 代码差异，用于展示建议的修改。file 为文件路径；diff 为逐行文本，以 "+" 开头为新增、"-" 为删除、空格为上下文；language 可选。只表示建议，不代表修改已应用或文件已保存；真实工具结果由宿主展示，不由模型生成。',
    props: z.object({ file: z.string().min(1).max(300), diff: z.string().min(1).max(20000), language: z.enum(['bash', 'diff', 'json', 'text', 'tsx']).optional() }),
  },
  EditableTable: {
    description: '可编辑表格，让用户在你动手前核对或修改一批记录（例如建任务前）。放在 Form 的 FormControl 里，Form 的按钮用 @ToAssistant 说明要做什么；用户改过的行随回复发回。name 为字段名；columns 每项 {type, key, header, options?}，type 为 text、number、date-single、select、url；data 每行 {id, values}，values 与 columns 等长。最多 6 列、30 行。只读数据用 BeTable。',
    props: z.object({
      name: z.string().min(1).max(80),
      columns: z.array(z.object({ type: z.enum(['text', 'number', 'date-single', 'select', 'url']), key: z.string().min(1).max(40), header: z.string().min(1).max(80), width: z.number().int().min(40).max(600).optional(), options: z.array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(80) })).max(20).optional() })).min(1).max(6),
      data: z.array(z.object({ id: z.string().min(1).max(80), values: z.array(z.union([z.string().max(2000), z.number().min(-1e12).max(1e12)])).max(6) })).max(30),
    }),
  },
} as const

export type AgentComponentName = keyof typeof agentComponentCatalog
export type AgentComponentRenderers = {
  [Name in AgentComponentName]: ComponentRenderer<z.infer<(typeof agentComponentCatalog)[Name]['props']>>
}

/**
 * Components that saved replies still use, replaced on 2026-10-31 (docs/design/decisions.md).
 * They parse with their old props and render as their replacement; the model never sees them.
 */
export const legacyAgentComponentCatalog = {
  ShadcnCard: { description: '旧回复：内容卡片，显示为 BeCard。', props: z.object({ title: text, children, description: text.optional() }) },
  ShadcnBadge: { description: '旧回复：状态标签。', props: z.object({ text, variant: z.enum(['default', 'secondary', 'outline', 'destructive']).optional() }) },
  ShadcnAlert: { description: '旧回复：提示，显示为 BeAlert。', props: z.object({ title: text, description: text, variant: z.enum(['default', 'destructive']).optional() }) },
  ShadcnProgress: { description: '旧回复：进度，显示为 RadialChart。', props: z.object({ label: text, value: z.number().min(0).max(100) }) },
  ShadcnAccordion: { description: '旧回复：折叠列表，每项显示为 BeCollapsible。', props: z.object({ items: z.array(z.object({ title: text, content: text })).max(10), multiple: z.boolean().optional() }) },
  ShadcnTabs: { description: '旧回复：标签页，显示为 BeTabs。', props: z.object({ items: z.array(z.object({ title: text, children })).max(6) }) },
  ShadcnTable: { description: '旧回复：表格，显示为 BeTable。', props: z.object({ columns: z.array(text).min(1).max(6), rows: z.array(z.array(text).max(6)).max(30) }) },
  ShadcnButton: { description: '旧回复：快捷提问按钮，显示为 BeButton。', props: z.object({ label: z.enum(['直接提问', '继续细化', '填入提问']), prompt: text, variant: z.enum(['default', 'secondary', 'outline', 'ghost']).optional() }) },
  ReuiBadge: { description: '旧回复：状态标签。', props: z.object({ text, variant: z.enum(['outline', 'secondary', 'primary-light', 'info-light', 'success-light', 'warning-light', 'destructive-light']).optional() }) },
  ReuiAlert: { description: '旧回复：提示，显示为 BeAlert。', props: z.object({ title: text, description: text, variant: z.enum(['default', 'info', 'success', 'warning', 'destructive']).optional() }) },
  ReuiFrame: { description: '旧回复：分组面板，显示为 BeCard。', props: z.object({ title: text, children, description: text.optional() }) },
  BeBadge: { description: '旧回复：状态标签。', props: z.object({ text: z.string().min(1).max(80), status: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'loading']).optional() }) },
  BeTimeline: { description: '旧回复：时间线，显示为步骤列表。', props: z.object({ events: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), title: z.string().min(1).max(80), description: z.string().max(300).optional(), meta: z.string().max(80).optional() })).min(1).max(12) }) },
} as const

export type LegacyAgentComponentName = keyof typeof legacyAgentComponentCatalog
export type LegacyAgentComponentRenderers = {
  [Name in LegacyAgentComponentName]: ComponentRenderer<z.infer<(typeof legacyAgentComponentCatalog)[Name]['props']>>
}
const LEGACY_NAMES = new Set<string>(Object.keys(legacyAgentComponentCatalog))
const MODEL_HIDDEN_NAMES = new Set<string>([
  ...LEGACY_NAMES,
  // Keep the selected beUI equivalents (docs/design/decisions.md, 2026-10-31).
  'Card', 'CardHeader', 'MarkDownRenderer', 'Callout', 'TextCallout', 'Image', 'ImageBlock', 'ImageGallery',
  'CodeBlock', 'Table', 'Col', 'Tabs', 'TabItem', 'Accordion', 'AccordionItem',
  // OpenUI charts lack the selected theme colours and progressive rendering.
  'RadarChart', 'HorizontalBarChart', 'Series', 'PieChart', 'SingleStackedBarChart', 'Slice', 'ScatterChart', 'ScatterSeries', 'Point',
  'ComputerCard', // Task state and approval UI belong to the host.
])

export const agentComponentGroups: { name: string; components: AgentComponentName[]; notes: string[] }[] = [
  { name: '消息回复', components: ['BeResponse'], notes: ['AI Elements MessageResponse → beUI StreamingResponse；回复正文可嵌套已注册组件。会话和输入框由宿主控制，不由模型创建。'] },
  { name: '审批与问题', components: ['BeApproval', 'BeQuestions'], notes: ['Confirmation → ApprovalCard；选择问题复用 ApprovalCard 提问模式。在回答区直接提交并继续对话，不执行工具、不持久保存审批。ToolApproval 已安装但仅供未来真实工具授权流程使用，不开放给模型伪造授权。'] },
  { name: '任务与进度', components: ['BeTodoList', 'BeStat'], notes: ['Plan/Task → TodoList；Loader/Shimmer → AgentProgress、ReasoningText、ThinkingShimmer，由宿主根据请求状态控制。建议计划保持待开始；数字只能来自用户输入。'] },
  { name: '图标状态与操作', components: ['AgentIcon', 'BeButton', 'BeFollowUps'], notes: ['Lucide 提供图标；状态标签用 OpenUI Tag；Button 提供操作反馈。不得用图标或标签伪造执行结果。'] },
  { name: '任务与来源引用', components: ['InlineText', 'TaskChip', 'RunChip', 'SourceChip', 'BeCitations', 'ComputerCard'], notes: ['BeCitations 列出本次真正读取过的网页，不编造来源。', '引用任务、运行和网页时用 InlineText 把文字和 chip 排在同一段，chip 是内联小标签，不用卡片。TaskChip、RunChip 只用工具返回的真实 id，宿主负责查出编号、标题和状态。', 'ComputerCard 的画面、真实状态和审批由宿主控制，不由模型生成；正文不再复述操作过程。'] },
  { name: '内容、报告与图表', components: ['TextContent', 'BeCodeBlock', 'BeCard', 'BeCardGrid', 'BeImageCard', 'BeImage', 'BeAlert', 'BeTable', 'EditableTable', 'BeTabs', 'BeCollapsible', 'BarChart', 'LineChart', 'AreaChart', 'DonutChart', 'RadialChart', 'Separator', 'BeFileTree', 'BeFileDiff'], notes: ['beUI CodeBlock 用于代码回复；BeFileDiff 只展示建议修改；ToolResult、AgentActivity、ImageGeneration 已安装，仅在有真实数据的宿主流程中使用，不开放给模型，不自动生成虚构工具记录。', '报告：提示用 BeAlert，表格用 BeTable，标签页用 BeTabs，状态用 Tag，里程碑用 Steps；趋势用 LineChart，分类对比用 BarChart，排行用 BarChart 横向，已用与上限用 RadialChart，图表颜色来自主题图表色，只用用户或工具提供的数字。批量确认多条记录（例如建任务前）用 Form 包 EditableTable，提交按钮的 @ToAssistant 写清要做什么。'] },
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenUI types each built-in renderer by its own props.
type AnyRenderer = ComponentRenderer<any>

/** `block` wraps OpenUI's own renderers, so the host can treat its cards, tables and charts like its own. */
export function createAgentLibrary(renderers: Partial<AgentComponentRenderers & LegacyAgentComponentRenderers> = {}, block?: (name: string, render: AnyRenderer) => AnyRenderer) {
  const catalog = { ...agentComponentCatalog, ...legacyAgentComponentCatalog }
  const names = Object.keys(catalog) as (keyof typeof catalog)[]
  const components = names.map(name => {
    const definition = catalog[name]
    return defineComponent({
      name,
      ...definition,
      component: (renderers[name] ?? (() => null)) as ComponentRenderer<z.infer<typeof definition.props>>,
    })
  })
  return createLibrary({
    root: 'Stack',
    components: [...Object.values(openuiLibrary.components).filter(component => !names.includes(component.name as keyof typeof catalog))
      .map(component => block ? { ...component, component: block(component.name, component.component) } : component), ...components],
    functions: Object.values(openuiLibrary.functions),
    actions: Object.values(openuiLibrary.actions) as DefinedAction[],
    componentGroups: agentComponentGroups,
  })
}

type LibrarySpec = { components: Record<string, unknown>; componentGroups: { name: string; components: string[]; notes: string[] }[]; schema: { properties?: Record<string, unknown>; required?: string[]; $defs?: Record<string, unknown> } }

/** One model catalog; hidden components still render saved replies and host content. */
export function agentPromptSpec<Spec extends LibrarySpec>(spec: Spec): Spec {
  const keep = (record: Record<string, unknown> = {}, hidden = MODEL_HIDDEN_NAMES) => Object.fromEntries(Object.entries(record).filter(([name]) => !hidden.has(name)))
  return {
    ...spec,
    components: keep(spec.components),
    componentGroups: spec.componentGroups.map(group => ({ ...group, components: group.components.filter(name => !MODEL_HIDDEN_NAMES.has(name)) })),
    // Built-in children still reference these type definitions; only offered component calls are hidden.
    schema: { ...spec.schema, properties: keep(spec.schema.properties), required: spec.schema.required?.filter(name => !MODEL_HIDDEN_NAMES.has(name)), $defs: keep(spec.schema.$defs, LEGACY_NAMES) },
  }
}
