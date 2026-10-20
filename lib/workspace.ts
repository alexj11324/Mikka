import { Activity, Bot, CircleDashed, FolderKanban, Inbox, Layers3, LayoutDashboard, ListTodo, Network, Zap } from "lucide-react"

export const views = [
  { id: "overview", label: "工作台", icon: LayoutDashboard, group: "personal" },
  { id: "inbox", label: "收件箱", icon: Inbox, group: "personal" },
  { id: "my-issues", label: "我的任务", icon: CircleDashed, group: "personal" },
  { id: "issues", label: "全部任务", icon: ListTodo, group: "workspace" },
  { id: "projects", label: "项目", icon: FolderKanban, group: "workspace" },
  { id: "agents", label: "Agent 团队", icon: Bot, group: "workspace" },
  { id: "automations", label: "自动化", icon: Zap, group: "workspace" },
  { id: "activity", label: "活动记录", icon: Activity, group: "workspace" },
] as const

export type ViewId = typeof views[number]["id"]
export type ModalKind = "issue" | "project" | "agent" | "automation" | "connection" | "setup" | "invite" | "search" | "workspace" | "help" | null

export const agentRoles = [
  { id: "orchestrator", name: "Orchestrator", label: "编排者", icon: Network, description: "分析依赖与优先级，拆解目标，为合适的 agent 分发任务。", capabilities: ["任务拆解", "依赖调度", "工作流编排"], tone: "violet" },
  { id: "worker", name: "Worker", label: "执行者", icon: Bot, description: "在独立 Git worktree 中实现任务，让不同 issue 的修改相互隔离。", capabilities: ["代码实现", "独立 worktree", "测试执行"], tone: "blue" },
  { id: "reviewer", name: "Reviewer", label: "审阅者", icon: Layers3, description: "检查实现与测试结果，在交付前提供独立的质量反馈。", capabilities: ["代码审查", "质量验证", "反馈闭环"], tone: "green" },
] as const

export type SetupStatus = { database: boolean; authSecret: boolean; reuiLicense: boolean }
