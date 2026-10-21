import type { OpenUIError, ParseResult } from '@openuidev/lang-core'

export type AgentUIIssue = { title: string; message: string }

const componentNames: Record<string, string> = {
  Table: '表格', ShadcnTable: '表格', Col: '表格列',
  BeImage: '配图', BeImageCard: '图文卡片', BeCardGrid: '推荐卡片', BeCard: '内容卡片',
  BeQuestions: '提问卡片', BeApproval: '确认卡片', BeTodoList: '任务清单',
  Form: '表单', FormControl: '表单字段', Input: '输入框',
  Tabs: '标签页', ShadcnTabs: '标签页', TextContent: '正文段落', BeResponse: '正文',
}

export function getAgentUIIssue(result: ParseResult | null, runtimeErrors: OpenUIError[] = []): AgentUIIssue | null {
  if (!result) return { title: '回复内容无法读取', message: '模型返回的内容格式有误，页面无法读取这条回复。' }
  if (result.meta.unresolved.length > 0) return {
    title: '回复缺少部分内容',
    message: `模型引用了 ${result.meta.unresolved.length} 段内容，却没有返回这些段落，因此无法显示。已收到的内容会保留。`,
  }
  const error = [...result.meta.errors, ...runtimeErrors].find(issue => issue.severity !== 'warning')
  if (error) {
    const component = error.component ? componentNames[error.component] ?? '内容组件' : '内容组件'
    if (error.code === 'unknown-component' || error.code === 'unknown-function') return {
      title: '部分内容无法显示', message: '模型使用了当前页面不支持的组件，该部分无法显示。其余内容已保留。',
    }
    if (error.code === 'no-root' || error.code === 'parse-failed' || error.code === 'parse-exception') return {
      title: '回复内容无法读取', message: '模型没有按页面支持的格式返回正文或卡片，因此这条回复无法显示。',
    }
    if (error.code === 'render-error' || error.code === 'runtime-error') return {
      title: '部分内容显示出错', message: `这条回复中的${component}在显示时发生错误。其余内容已保留。`,
    }
    return { title: '部分内容无法显示', message: `模型返回的${component}数据格式不正确，这部分无法显示。其余内容已保留。` }
  }
  if (!result.root) return { title: '回复没有可显示的内容', message: '模型没有返回可显示的正文或卡片。' }
  return null
}
