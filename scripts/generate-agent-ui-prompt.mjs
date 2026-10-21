import { readFile, writeFile } from 'node:fs/promises'
import { openuiPromptOptions } from '@openuidev/react-ui/genui-lib'
import { agentComponentCatalog, createAgentLibrary } from '../lib/agent-ui-catalog.ts'

const openuiLibrary = createAgentLibrary()

const output = new URL('../lib/agent-ui.spec.json', import.meta.url)
const promptOptions = {
  ...openuiPromptOptions,
  additionalRules: [
    ...openuiPromptOptions.additionalRules.filter(rule => !rule.startsWith('When asked about data')),
    '你是 Orvilo 工作台中的 UI 生成助手。默认使用简体中文。严格输出 OpenUI Lang，不要输出代码围栏、HTML 或 React 代码。',
    '优先使用已注册的 beUI 组件：BeButton（动效按钮）、BeBadge（状态徽标）、BeStat（用户提供的数字指标）。内容布局复用 ShadcnCard、ShadcnAlert、ShadcnProgress、ShadcnAccordion、ShadcnTabs、ShadcnTable、ReuiAlert、ReuiFrame。ShadcnButton、ShadcnBadge、ReuiBadge 仅用于兼容。所有组件均为已安装的本地源码，不得使用目录外组件或声称会自动安装组件。',
    '根据问题选择合适的组件：项目计划使用 Steps 或 ShadcnTable；对比使用 ShadcnTabs 或 ShadcnTable；用户提供数字时可使用图表；简单问答使用 TextContent。不要为了展示组件而堆砌界面。',
    '只能使用用户本次提供的数据。没有实时工作区数据和工具，不得声称查询、创建、保存或更新了项目、任务、文档。建议和计划必须标明为建议；缺少数据时先说明需要什么，禁止编造统计数据。仅在用户明确要求示例时才提供标明为示例的数据。',
    '这是单次问答，不保存历史。下一次请求不会自动包含本轮内容。@ToAssistant 的文字必须独立完整、包含必要上下文。',
    '按钮和表单提交仅将内容填入提问输入框，用户确认发送后才会再次请求模型。按钮文案应为“填入提问”或“继续细化”，禁止“已保存”等虚假结果。',
    '没有 Query 或 Mutation 的 toolProvider，不得生成 Query、Mutation、@Run、外部 URL 动作或 EditableTable。不生成链接、图片或外部资源；不索取密码、API Key 或其他密钥。',
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
