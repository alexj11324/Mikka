/**
 * Sample data for the first build. The screens read only from here until the
 * mobile API exists (mobile.md, "Engineering prerequisites"); the copy follows
 * R-45 (verb first, says who) and R-46 (a warm, professional secretary).
 */
export type Source = 'gmail' | 'github' | 'slack' | 'notion' | 'linear' | 'calendar'
export type Machine = 'cloud' | 'laptop' | 'server'
export type ThreadStatus = 'running' | 'waiting' | 'review' | 'failed' | 'done' | 'draft' | 'merged' | 'closed'
export type BotLook = { color: string; shape: 'circle' | 'squircle' | 'flower' | 'cloud' | 'cat' | 'drop' }

export type Bot = { id: string; name: string; look: BotLook; pinned?: boolean; unread?: boolean }

export const coordinator: Bot = { id: 'coordinator', name: 'Coordinator', look: { color: '#111111', shape: 'circle' } }

export const bots: Bot[] = [
  { id: 'backend', name: 'Mikka Backend', look: { color: '#2F6BFF', shape: 'squircle' }, pinned: true },
  { id: 'frontend', name: 'Mikka Frontend', look: { color: '#1F9D6B', shape: 'flower' }, pinned: true, unread: true },
  { id: 'release', name: '发布小组', look: { color: '#F5A524', shape: 'cloud' } },
  { id: 'research', name: 'Research', look: { color: '#8B5CF6', shape: 'cat' } },
  { id: 'weekly', name: '周报助手', look: { color: '#E5484D', shape: 'drop' } },
]

export type Thread = {
  id: string
  title: string
  status: ThreadStatus
  bot: string
  machine: Machine
  harness: string
  unread?: boolean
  archived?: boolean
}

export const machines: { id: Machine; name: string }[] = [
  { id: 'cloud', name: 'Mikka Cloud' },
  { id: 'laptop', name: 'Mac' },
  { id: 'server', name: 'Oracle' },
]

export const threads: Thread[] = [
  { id: 'mik-41', title: 'MIK-41 接入 Slack App', status: 'waiting', bot: 'Mikka Backend', machine: 'cloud', harness: 'Claude Code', unread: true },
  { id: 'pr-212', title: '修复 PR #212 类型检查', status: 'running', bot: 'Mikka Backend', machine: 'cloud', harness: 'Codex' },
  { id: 'site-speed', title: '官网首页加载提速', status: 'running', bot: 'Mikka Frontend', machine: 'laptop', harness: 'Claude Code' },
  { id: 'mik-38', title: 'MIK-38 任务转个人后端', status: 'review', bot: 'Mikka Backend', machine: 'laptop', harness: 'Codex', unread: true },
  { id: 'q4-research', title: '整理 Q4 竞品资料', status: 'failed', bot: 'Research', machine: 'cloud', harness: 'Claude Code' },
  { id: 'mik-36', title: 'MIK-36 线程卡片去掉步骤行', status: 'merged', bot: 'Mikka Frontend', machine: 'laptop', harness: 'Claude Code' },
  { id: 'weekly-43', title: '周报：10 月第 4 周', status: 'done', bot: '周报助手', machine: 'cloud', harness: 'Claude Code' },
  { id: 'kevin-reply', title: '回复 Kevin：会议改到周三', status: 'done', bot: 'Coordinator', machine: 'cloud', harness: 'Claude Code', archived: true },
]

export const threadSteps: Record<string, { done: string[]; running?: string; reply?: string }> = {
  'pr-212': {
    done: ['读取 CI 日志：tsgo 报 3 处类型错误', '修改 lib/coordinator/decide.ts', '修改 lib/suggestions/rules.ts'],
    reply: '类型错误来自 DecisionAnswer 新加的 choice 分支，三处都已补上判断。现在跑 typecheck 和 test:suggestions。',
    running: 'pnpm typecheck',
  },
}

export type Suggestion = { id: string; source: Source; title: string; meta: string }

/** 建议: normal items, one list, verb first (R-21, R-45). */
export const suggestions: Suggestion[] = [
  { id: 's1', source: 'gmail', title: '核对 Stripe 10 月账单', meta: 'Gmail · 08:12' },
  { id: 's2', source: 'slack', title: '回复 Jason：发布前要不要冻结 main', meta: 'Slack · #mikka-dev · 07:58' },
  { id: 's3', source: 'slack', title: '把抽屉交互稿发给 Mei', meta: 'Slack · #design · 07:40' },
  { id: 's4', source: 'linear', title: '开始 MIK-44 手机推送设备表', meta: 'Linear · 分配给你 · 07:15' },
  { id: 's5', source: 'notion', title: '过一遍发布清单新增的 3 项 iOS 检查', meta: 'Notion · 昨天' },
  { id: 's6', source: 'slack', title: '约 Lin 明天下午对 OKR', meta: 'Slack · 私信 · 昨天' },
  { id: 's7', source: 'github', title: '合并 Dependabot：next 升到 16.1.7', meta: 'GitHub · 昨天' },
]

export type Task = { id: string; key: string; title: string; status: 'todo' | 'doing' | 'review' | 'done'; assignee: string }

export const tasks: Task[] = [
  { id: 't44', key: 'MIK-44', title: '手机推送设备表', status: 'todo', assignee: 'Alex' },
  { id: 't41', key: 'MIK-41', title: '接入 Slack App', status: 'doing', assignee: 'Mikka Backend' },
  { id: 't42', key: 'MIK-42', title: '官网首页加载提速', status: 'doing', assignee: 'Mikka Frontend' },
  { id: 't38', key: 'MIK-38', title: '任务转个人后端', status: 'review', assignee: 'Mikka Backend' },
  { id: 't36', key: 'MIK-36', title: '线程卡片去掉步骤行', status: 'done', assignee: 'Mikka Frontend' },
]

export const me = { name: 'Alex Jiang', initials: 'AL', email: 'alex@aspectlylabs.com', workspace: '个人' }

export const workspaces = ['个人', 'Aspectly Labs']

export const connectedApps: { source: Source; name: string; account: string }[] = [
  { source: 'gmail', name: 'Gmail', account: 'alex@aspectlylabs.com' },
  { source: 'github', name: 'GitHub', account: 'alexj11324' },
  { source: 'slack', name: 'Slack', account: 'Aspectly Labs' },
  { source: 'notion', name: 'Notion', account: 'Mikka' },
]

export const availableApps: { source: Source; name: string }[] = [
  { source: 'linear', name: 'Linear' },
  { source: 'calendar', name: 'Google 日历' },
]

/** 记忆摘要: one Markdown document (ChatGPT 记忆摘要; Alex 2026-10-27). */
export const memoryMarkdown = `## 概览

你是 Alex，在做 Mikka：一个把 Claude Code、Codex 等编码 agent 组织成团队的产品。中文交流为主，提到英文概念时附上英文术语。

## 你负责的事

- Mikka 的后端和每次发布
- 手机端 App 的产品和设计
- 审阅 Mikka Backend 开出的 PR

## 不用找你的事

- Dependabot 的依赖升级，直接合并
- #random 频道里的消息

## 习惯

- 每天早上 8 点看简报
- 周报在周一早上发到 Notion`
