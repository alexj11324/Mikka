"use client"

import { useState } from "react"
import { ArrowRight, ArrowUpDown, Bot, ChevronDown, CircleDashed, Filter, FolderKanban, GitBranch, History, Inbox, Layers3, LayoutGrid, List, Plus, Search, ShieldCheck, SlidersHorizontal, Terminal, Workflow, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { agentRoles, type ModalKind, type ViewId } from "@/lib/workspace"

export function WorkspaceViews({ view, open }: { view: Exclude<ViewId, "overview">; open: (kind: ModalKind) => void }) {
  const [tab, setTab] = useState("all")
  const [filterOpen, setFilterOpen] = useState(false)
  const [search, setSearch] = useState("")
  if (view === "agents") return <AgentsView open={open} />
  if (view === "automations") return <AutomationsView open={open} />
  const configs = {
    issues: { title: "全部任务", description: "从一个明确的任务，到一次可靠的交付。", icon: CircleDashed, empty: "清晰的任务，是好工作的起点", detail: "创建任务、设置优先级与依赖，再交给你的团队或 Agent。", action: "创建任务", modal: "issue" },
    "my-issues": { title: "我的任务", description: "专注于此刻最重要的工作。", icon: CircleDashed, empty: "你的专注空间", detail: "登录并加入工作空间后，分配给你的任务会显示在这里。", action: "设置账号", modal: "setup" },
    projects: { title: "项目", description: "让目标、任务和 Agent 团队保持一致。", icon: FolderKanban, empty: "下一个精彩项目，正在等你", detail: "用项目组织目标与仓库，让每一个任务都指向同一个方向。", action: "创建项目", modal: "project" },
    inbox: { title: "收件箱", description: "只关注与你相关的动态。", icon: Inbox, empty: "此刻，安静而有序", detail: "任务分配、评论提及和 Agent 审阅完成后，会在这里通知你。", action: "设置账号", modal: "setup" },
    activity: { title: "活动记录", description: "团队和 Agent 的每一步，都有迹可循。", icon: History, empty: "工作空间的故事，从这里记录", detail: "项目、任务、评论和 Agent 的真实执行活动将在这里显示。", action: "创建任务", modal: "issue" },
  } as const
  const config = configs[view]
  return <div className="flex min-h-full flex-col">
    <div className="flex flex-wrap items-center justify-between gap-4 px-6 pb-5 pt-7 sm:px-8"><div><h1 className="text-xl font-semibold tracking-tight">{config.title}</h1><p className="mt-2 text-xs text-muted-foreground">{config.description}</p></div><Button size="sm" onClick={() => open(config.modal)}><Plus data-icon="inline-start" />{config.action}</Button></div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-y px-6 py-2 sm:px-8"><Tabs value={tab} onValueChange={value => setTab(String(value))}><TabsList variant="line"><TabsTrigger value="all">全部</TabsTrigger><TabsTrigger value="active">进行中</TabsTrigger><TabsTrigger value="done">已完成</TabsTrigger></TabsList></Tabs><div className="flex items-center gap-1"><Button variant="ghost" size="sm" onClick={() => setFilterOpen(!filterOpen)} aria-expanded={filterOpen}><Filter data-icon="inline-start" />筛选</Button><Button variant="ghost" size="icon-sm" aria-label="搜索" onClick={() => { setFilterOpen(true) }}><Search /></Button></div></div>
    {filterOpen && <div className="flex flex-wrap gap-3 border-b bg-muted/20 px-8 py-3"><Input aria-label="搜索名称" value={search} onChange={e => setSearch(e.target.value)} placeholder="按名称搜索…" className="max-w-64" /><NativeSelect aria-label="优先级筛选" defaultValue="all"><NativeSelectOption value="all">全部优先级</NativeSelectOption><NativeSelectOption value="urgent">紧急</NativeSelectOption><NativeSelectOption value="high">高</NativeSelectOption><NativeSelectOption value="normal">普通</NativeSelectOption></NativeSelect></div>}
    <div className="grid grid-cols-[1fr_100px_100px] border-b bg-muted/25 px-8 py-2.5 text-[10px] text-muted-foreground"><span>名称</span><span>状态</span><span className="text-right">负责人</span></div>
    <Empty className="min-h-[430px] rounded-none"><EmptyHeader><EmptyMedia variant="icon"><config.icon /></EmptyMedia><EmptyTitle>{search ? "没有匹配的结果" : config.empty}</EmptyTitle><EmptyDescription>{search ? "当前工作空间尚未有可搜索的数据。" : config.detail}</EmptyDescription></EmptyHeader><EmptyContent><Button size="sm" onClick={() => open(config.modal)}><Plus data-icon="inline-start" />{config.action}</Button><p className="mt-2 text-[10px] text-muted-foreground">完成账号配置后启用持久化工作空间</p></EmptyContent></Empty>
    <div className="mt-auto flex items-center justify-between border-t px-8 py-3 text-[10px] text-muted-foreground"><span>尚未加载账号数据</span><span>Neon · 持久化存储</span></div>
  </div>
}

function AgentsView({ open }: { open: (kind: ModalKind) => void }) {
  return <div className="mx-auto flex max-w-[1120px] flex-col gap-7 px-6 py-8 sm:px-8"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="mb-2 text-[10px] text-primary">人负责方向，Agent 负责推进</div><h1 className="text-2xl font-semibold tracking-tight">你的 Agent 团队</h1><p className="mt-2 text-xs text-muted-foreground">各司其职，协同交付。以角色组织工作，而不是堆叠对话。</p></div><Button size="sm" onClick={() => open("agent")}><Plus data-icon="inline-start" />创建 Agent</Button></div>
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 px-4 py-3"><Terminal className="size-4 text-muted-foreground" /><div><p className="text-xs font-medium">还未连接本机运行环境</p><p className="mt-1 text-[10px] text-muted-foreground">通过 daemon 连接 Claude Agent SDK。代码与执行环境留在你的电脑。</p></div><Button variant="outline" size="sm" className="ml-auto" onClick={() => open("connection")}>连接本机<ArrowRight data-icon="inline-end" /></Button></div>
    <section><div className="mb-4 flex items-center justify-between"><h2 className="text-xs font-semibold">三种角色，一条交付链</h2><Badge variant="outline">角色模板 · 尚未创建</Badge></div><div className="grid gap-4 lg:grid-cols-3">{agentRoles.map(role => <article key={role.id} className="flex flex-col rounded-xl border bg-card p-5"><span className={`role-icon ${role.tone} mb-5`}><role.icon className="size-4" /></span><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">{role.name}</h3><span className="text-[10px] text-muted-foreground">{role.label}</span></div><p className="mt-3 min-h-14 text-[11px] leading-6 text-muted-foreground">{role.description}</p><div className="my-4 flex flex-wrap gap-1.5">{role.capabilities.map(capability => <Badge variant="secondary" key={capability}>{capability}</Badge>)}</div><Button variant="outline" size="sm" className="mt-auto" onClick={() => open("agent")}><Plus data-icon="inline-start" />配置此角色</Button></article>)}</div></section>
    <section className="rounded-lg border border-dashed p-6"><div className="flex items-center gap-2 text-xs font-medium"><ShieldCheck className="size-4 text-success" />自主，不意味着失控。</div><p className="mt-3 max-w-2xl text-[11px] leading-6 text-muted-foreground">每个 issue 在独立的 Git worktree 中执行。仓库白名单、命令权限、并发上限和审阅要求由本机 daemon 强制检查。运行链路完成配置前，不会启动任何 agent 或执行命令。</p></section>
  </div>
}

function AutomationsView({ open }: { open: (kind: ModalKind) => void }) {
  return <div className="mx-auto flex max-w-[1120px] flex-col gap-7 px-6 py-8 sm:px-8"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="mb-2 text-[10px] text-primary">把重复的协调，交给规则</div><h1 className="text-2xl font-semibold tracking-tight">自动化</h1><p className="mt-2 text-xs text-muted-foreground">用事件和时间触发工作，让团队持续向前。</p></div><Button size="sm" onClick={() => open("automation")}><Plus data-icon="inline-start" />新建自动化</Button></div><div className="flex items-center gap-2 border-b pb-4 text-xs font-medium"><Workflow className="size-4 text-muted-foreground" />从一个触发器开始<Badge variant="secondary">配置模板</Badge></div><div className="grid gap-4 md:grid-cols-2">{[{ icon: GitBranch, title: "PR 有了新反馈", trigger: "GitHub webhook", description: "收到审阅反馈后，关联 issue 并调度 Worker 修复，再由 Reviewer 复核。" }, { icon: Zap, title: "按计划推进任务", trigger: "定时触发", description: "按设定的时间检查待办任务，根据优先级、依赖和并发规则进行调度。" }].map(item => <article key={item.title} className="flex flex-col rounded-xl border p-6"><item.icon className="mb-5 size-5 text-primary" /><Badge variant="outline">{item.trigger}</Badge><h2 className="mt-3 text-sm font-semibold">{item.title}</h2><p className="mb-5 mt-3 text-[11px] leading-6 text-muted-foreground">{item.description}</p><Button className="mt-auto w-fit" variant="outline" size="sm" onClick={() => open("automation")}>配置规则<ArrowRight data-icon="inline-end" /></Button></article>)}</div><Empty className="min-h-48 border border-dashed"><EmptyHeader><EmptyTitle>还没有启用的自动化</EmptyTitle><EmptyDescription>连接账号、仓库和本机 daemon 后，即可启用规则内的自动执行。</EmptyDescription></EmptyHeader></Empty></div>
}
