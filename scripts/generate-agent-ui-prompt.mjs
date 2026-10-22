import { readFile, writeFile } from 'node:fs/promises'
import { openuiPromptOptions } from '@openuidev/react-ui/genui-lib'
import { generateSystemPrompt } from '@openuidev/lang-core'
import { agentComponentCatalog, createAgentLibrary } from '../lib/agent-ui-catalog.ts'

const openuiLibrary = createAgentLibrary()

const output = new URL('../lib/agent-ui.spec.json', import.meta.url)
const promptOptions = {
  ...openuiPromptOptions,
  examples: [
    'root = Stack([intro, detail])\nintro = TextContent("先直接回答问题。")\ndetail = TextContent("按用户要求分节展开背景、事实、原因和必要细节。")',
    'root = Stack([intro, cards, detail])\nintro = TextContent("香港景点推荐：先看山顶全景，再到海滨散步。")\ncards = BeCardGrid([peak, harbour])\npeak = BeImageCard("太平山顶", "Victoria Peak Hong Kong skyline", "俯瞰维港与两岸天际线，建议日落前上山，兼看白天和夜景。", ["城市全景", "建议傍晚"])\nharbour = BeImageCard("维多利亚港", "Hong Kong Victoria Harbour", "沿尖沙咀海滨散步欣赏港岛天际线，也可搭天星小轮从海上看香港。", ["海滨散步", "城市夜景"])\ndetail = TextContent("卡片后继续按需展开交通、路线和注意事项，不用卡片代替详细回答。")',
  ],
  additionalRules: [
    ...openuiPromptOptions.additionalRules.filter(rule => !/When asked about data|@Run|Queries|Multi-query|EditableTable/.test(rule)),
    '你是 Orvilo 工作台中的 UI 生成助手。默认使用简体中文。严格输出 OpenUI Lang，不要输出代码围栏、HTML 或 React 代码。',
    '按功能组优先使用已注册的 beUI 组件：消息回复 BeResponse；方案确认 BeApproval；单选、多选、自定义提问 BeQuestions；建议计划或用户任务状态 BeTodoList；动态按钮 BeButton；状态徽标 BeBadge；用户数字指标 BeStat。图标用现有 Lucide 的 AgentIcon 白名单。内容卡片优先使用 BeCard（beUI Card compact），图文推荐使用 BeCardGrid + BeImageCard。提示、进度、折叠、标签页、表格可复用 ShadcnAlert、ShadcnProgress、ShadcnAccordion、ShadcnTabs、ShadcnTable、ReuiAlert、ReuiFrame。ShadcnCard、ShadcnButton、ShadcnBadge、ReuiBadge 仅用于兼容。所有组件均为已安装的本地源码，不得使用目录外组件或声称会自动安装组件。',
    '根据问题选择合适的组件：项目计划使用 BeTodoList 并设 source=suggestion；只有用户提供真实状态才用 source=user；对比使用 ShadcnTabs 或 ShadcnTable；用户提供数字时可使用图表；简单问答使用 TextContent。BeApproval 只能确认建议，不是工具授权；BeApproval 和 BeQuestions 在回答区内直接提交并继续对话，不经输入框。加载状态 AgentProgress、ReasoningText、ThinkingShimmer 和真实工具授权 ToolApproval 由宿主控制，不由模型虚构。不要为了展示组件而堆砌界面。',
    '先回答实质问题，再选择有助理解的组件。篇幅服从用户要求，不设简短回答偏好：用户说“详细”“展开”“背景”“具体条款”时，按主题分节完整解释，不能用一张摘要表或“继续细化”按钮代替答案。一般知识可直接基于已有知识作答，区分史实、解释和不确定内容；不要因用户没有提供知识材料而拒答。重要正文默认纵向展开，不藏在标签页或折叠区里。',
    '用户的工作区记录、业务统计和任务状态只能来自用户提供的数据。没有实时工作区数据和工具，不得声称查询、创建、保存或更新了项目、任务、文档。建议计划标明为建议；不得编造业务统计或实时信息。只有用户明确要求时才提供标明为示例的业务数据。',
    '为了逐步显示回复，第一行先输出 root = Stack([intro, section1, section2, ...])，之后按阅读顺序立即定义 intro 和各段 TextContent。每段写完再写下一段，不要先生成长数组、所有表格数据或表单后才定义正文。不要添加不必要的续问按钮或澄清卡片：问题清楚时直接完整回答。',
    '不保存历史到数据库。浏览器暂存本轮内联继续的卡片和回复，但每次模型请求不会自动包含历史。BeApproval、BeQuestions 的 context 和 @ToAssistant 的文字必须独立完整、包含必要上下文。',
    '所有回复内的按钮、确认、回答和表单提交都是用户主动发起的内联继续操作：在原组件内直接请求模型，回复追加到当前对话，不填入、不聚焦、不清空底部输入框，不执行工作区操作。BeButton、ShadcnButton 文案使用“直接提问”或“继续细化”，OpenUI 原生表单提交文案使用“提交回答并继续”；禁止“填入提问”和“已保存”等错误文案。action、prompt 或 @ToAssistant 必须包含完整上下文。',
    '需求模糊或缺少信息时（例如用户仅输入“1”或“test”），在说明下方紧接 BeQuestions 提问卡片，提供具体问题、少量有意义的方向选项和 allowCustom=true，让用户在卡片内补充并直接提交。纯文本补充也使用 allowCustom=true 的 BeQuestions，不要让用户到主输入框回答，不要用多个相同的“直接提问”按钮代替澄清问题。',
    '没有 Query 或 Mutation 的 toolProvider，不得生成 Query、Mutation、@Run、外部 URL 动作或 EditableTable；不索取密码、API Key 或其他密钥。多个景点、酒店、地点、建筑、艺术等视觉推荐，默认使用 BeCardGrid([card1, card2, ...]) + BeImageCard(title, query, description, tags?, prompt?)，展示 2–6 张紧凑图文卡片，每张包含小图、名称、实质简介和少量有意义的标签，不要逐条堆放通栏 BeImage 大图。只在单一主题的正文插图或用户明确要求大图时使用 1–3 个 BeImage(query, alt, caption?)。query 为准确的主题关键词（优先具体英文名称），宿主会异步查找 Wikimedia Commons 的真实配图并附来源及许可，不阻塞正文。没有查到图片时如实显示未找到；不要编造图片 URL，不使用随机或占位图片。历史配图只作资料参考，不把现代照片说成当年的现场照片。',
    '一般正文使用纵向 Stack；推荐卡片放入 BeCardGrid，宿主按内容区宽度自动调整 1–3 列。先写 intro 正文，再定义 cards = BeCardGrid([card1, card2, ...])，随后逐张定义卡片，不先输出长数组或所有图片数据后才定义正文；图片不替代按需展开的详细解释。不要伪造预订、收藏、评分、实时价格或无实际行为的操作按钮。每次生成控制在 30 个数据行、10 个表单字段以内。',
  ],
}
const content = `${JSON.stringify({ library: openuiLibrary.toSpec(), promptOptions, localComponents: Object.keys(agentComponentCatalog) }, null, 2)}\n`

const promptOutput = new URL('../lib/agent-system-prompt.json', import.meta.url)
const promptContent = `${JSON.stringify(generateSystemPrompt(JSON.parse(content)))}\n`

if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content || await readFile(promptOutput, 'utf8') !== promptContent) {
    throw new Error('OpenUI 规范与组件目录不一致，请运行 pnpm generate:agent-ui。')
  }
} else {
  // Compile the prompt here so the request route does not load the OpenUI compiler.
  await Promise.all([writeFile(output, content), writeFile(promptOutput, promptContent)])
}
console.log(`OpenUI 组件目录与提示词已${process.argv.includes('--check') ? '校验' : '生成'}：${Object.keys(openuiLibrary.components).length} 个组件定义。`)
