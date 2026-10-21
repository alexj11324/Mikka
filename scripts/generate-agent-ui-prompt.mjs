import { readFile, writeFile } from 'node:fs/promises'
import { openuiPromptOptions } from '@openuidev/react-ui/genui-lib'
import { agentComponentCatalog, createAgentLibrary } from '../lib/agent-ui-catalog.ts'

const openuiLibrary = createAgentLibrary()

const output = new URL('../lib/agent-ui.spec.json', import.meta.url)
const promptOptions = {
  ...openuiPromptOptions,
  examples: [
    'root = Stack([intro, detail])\nintro = TextContent("先直接回答问题。")\ndetail = TextContent("按用户要求分节展开背景、事实、原因和必要细节。")',
    'root = Stack([intro, photo, detail])\nintro = TextContent("维多利亚港是香港的代表性景点。")\nphoto = BeImage("Hong Kong Victoria Harbour", "维多利亚港资料配图")\ndetail = TextContent("继续介绍观景位置和游览建议；配图不替代文字回答。")',
  ],
  additionalRules: [
    ...openuiPromptOptions.additionalRules.filter(rule => !/When asked about data|@Run|Queries|Multi-query|EditableTable/.test(rule)),
    '你是 Orvilo 工作台中的 UI 生成助手。默认使用简体中文。严格输出 OpenUI Lang，不要输出代码围栏、HTML 或 React 代码。',
    '按功能组优先使用已注册的 beUI 组件：消息回复 BeResponse；方案确认 BeApproval；单选、多选、自定义提问 BeQuestions；建议计划或用户任务状态 BeTodoList；动态按钮 BeButton；状态徽标 BeBadge；用户数字指标 BeStat。图标用现有 Lucide 的 AgentIcon 白名单。内容布局复用 ShadcnCard、ShadcnAlert、ShadcnProgress、ShadcnAccordion、ShadcnTabs、ShadcnTable、ReuiAlert、ReuiFrame。ShadcnButton、ShadcnBadge、ReuiBadge 仅用于兼容。所有组件均为已安装的本地源码，不得使用目录外组件或声称会自动安装组件。',
    '根据问题选择合适的组件：项目计划使用 BeTodoList 并设 source=suggestion；只有用户提供真实状态才用 source=user；对比使用 ShadcnTabs 或 ShadcnTable；用户提供数字时可使用图表；简单问答使用 TextContent。BeApproval 只能确认建议，不是工具授权；BeApproval 和 BeQuestions 在回答区内直接提交并继续对话，不经输入框。加载状态 AgentProgress、ReasoningText、ThinkingShimmer 和真实工具授权 ToolApproval 由宿主控制，不由模型虚构。不要为了展示组件而堆砌界面。',
    '先回答实质问题，再选择有助理解的组件。篇幅服从用户要求，不设简短回答偏好：用户说“详细”“展开”“背景”“具体条款”时，按主题分节完整解释，不能用一张摘要表或“继续细化”按钮代替答案。一般知识可直接基于已有知识作答，区分史实、解释和不确定内容；不要因用户没有提供知识材料而拒答。重要正文默认纵向展开，不藏在标签页或折叠区里。',
    '用户的工作区记录、业务统计和任务状态只能来自用户提供的数据。没有实时工作区数据和工具，不得声称查询、创建、保存或更新了项目、任务、文档。建议计划标明为建议；不得编造业务统计或实时信息。只有用户明确要求时才提供标明为示例的业务数据。',
    '为了逐步显示回复，第一行先输出 root = Stack([intro, section1, section2, ...])，之后按阅读顺序立即定义 intro 和各段 TextContent。每段写完再写下一段，不要先生成长数组、所有表格数据或表单后才定义正文。不要添加不必要的续问按钮或澄清卡片：问题清楚时直接完整回答。',
    '不保存历史到数据库。浏览器暂存本轮内联继续的卡片和回复，但每次模型请求不会自动包含历史。BeApproval、BeQuestions 的 context 和 @ToAssistant 的文字必须独立完整、包含必要上下文。',
    '所有回复内的按钮、确认、回答和表单提交都是用户主动发起的内联继续操作：在原组件内直接请求模型，回复追加到当前对话，不填入、不聚焦、不清空底部输入框，不执行工作区操作。BeButton、ShadcnButton 文案使用“直接提问”或“继续细化”，OpenUI 原生表单提交文案使用“提交回答并继续”；禁止“填入提问”和“已保存”等错误文案。action、prompt 或 @ToAssistant 必须包含完整上下文。',
    '需求模糊或缺少信息时（例如用户仅输入“1”或“test”），在说明下方紧接 BeQuestions 提问卡片，提供具体问题、少量有意义的方向选项和 allowCustom=true，让用户在卡片内补充并直接提交。纯文本补充也使用 allowCustom=true 的 BeQuestions，不要让用户到主输入框回答，不要用多个相同的“直接提问”按钮代替澄清问题。',
    '没有 Query 或 Mutation 的 toolProvider，不得生成 Query、Mutation、@Run、外部 URL 动作或 EditableTable；不索取密码、API Key 或其他密钥。旅游景点、地理、建筑、艺术等适合配图的介绍，以及用户要求图片时，使用 1–3 个 BeImage(query, alt, caption?)，query 为准确的主题关键词（优先具体英文名称），宿主会异步查找 Wikimedia Commons 的真实配图并附来源及许可，不阻塞正文。没有查到图片时如实显示未找到；不要编造图片 URL，不使用随机或占位图片。历史配图只作资料参考，不把现代照片说成当年的现场照片。',
    '采用适应窄屏的纵向 Stack 或可换行布局。每次生成控制在 30 个数据行、10 个表单字段以内。',
  ],
}
const content = `${JSON.stringify({ library: openuiLibrary.toSpec(), promptOptions, localComponents: Object.keys(agentComponentCatalog) }, null, 2)}\n`

if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content) {
    throw new Error('OpenUI 规范与组件目录不一致，请运行 pnpm generate:agent-ui。')
  }
} else {
  // The library imports client components; generate prompt data outside Next.js server compilation.
  await writeFile(output, content)
}
console.log(`OpenUI 组件目录与提示词已${process.argv.includes('--check') ? '校验' : '生成'}：${Object.keys(openuiLibrary.components).length} 个组件定义。`)
