"use client"

import { ArrowDown, ArrowRight, ArrowUpRight, Bot, Check, CheckCheck, Circle, CircleCheck, Code2, Command, Cpu, Database, FileText, GitBranch, Layers3, LockKeyhole, Network, Plus, Rocket, ShieldCheck, Sparkles, Terminal, Workflow } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { type ModalKind, type SetupStatus, type ViewId } from "@/lib/workspace"

export function Overview({ open, navigate, setup }: { open: (kind: ModalKind) => void; navigate: (view: ViewId) => void; setup: SetupStatus }) {
  return <div className="mx-auto flex w-full max-w-[1220px] flex-col gap-7 px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-primary" />为人与 Agent 一起工作而设计</div><h1 className="text-[25px] font-semibold tracking-tight sm:text-[28px]">更少协调，更多创造。</h1><p className="mt-2 text-xs leading-6 text-muted-foreground">把目标变成任务，让你的 Agent 团队接力完成。</p></div>
      <Button variant="outline" size="sm" onClick={() => open("help")}><FileText data-icon="inline-start" />快速开始<ArrowUpRight data-icon="inline-end" /></Button>
    </div>
    <section className="getting-started overflow-hidden rounded-xl border bg-card" aria-labelledby="get-started-heading">
      <div className="flex flex-col lg:flex-row">
        <div className="flex flex-1 flex-col p-6 sm:p-7">
          <div className="mb-5 flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-lg border bg-background"><Rocket className="size-3.5 text-primary" /></span><Badge variant="secondary">从这里开始</Badge></div>
          <h2 id="get-started-heading" className="text-lg font-semibold tracking-tight">你的下一个项目，从 Orbit 开始。</h2>
          <p className="mt-2 max-w-[360px] text-xs leading-6 text-muted-foreground">连接本机 Claude，创建任务和执行规则。<br className="hidden sm:block" />从一个想法，到一个经过审阅的交付。</p>
          <div className="mt-6 flex items-center gap-2"><Button size="sm" onClick={() => open("project")}><Plus data-icon="inline-start" />创建项目</Button><Button variant="ghost" size="sm" onClick={() => open("connection")}>连接本机 Agent<ArrowRight data-icon="inline-end" /></Button></div>
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><GitBranch className="size-3" />Worktree 隔离</span><span className="flex items-center gap-1.5"><ShieldCheck className="size-3" />规则内自主执行</span><span className="flex items-center gap-1.5"><Code2 className="size-3" />代码留在本机</span></div>
        </div>
        <div className="workflow-canvas flex min-h-[265px] flex-1 items-center justify-center border-t p-6 lg:max-w-[44%] lg:border-l lg:border-t-0" aria-label="预期工作流：编排者分发任务，执行者实现，审阅者验证；当前尚未配置">
          <div className="flex w-full max-w-[290px] flex-col items-center">
            <div className="flow-node flex w-[202px] items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 shadow-sm"><span className="role-icon violet"><Network className="size-4" /></span><div><p className="text-[11px] font-medium">Orchestrator</p><p className="mt-0.5 text-[9px] text-muted-foreground">拆解 · 规划 · 调度</p></div><span className="ml-auto rounded border px-1 text-[8px] text-muted-foreground">编排</span></div>
            <div className="h-6 border-l border-dashed border-primary/35" /><div className="flex w-full items-center"><div className="h-4 flex-1 rounded-tl-lg border-l border-t border-dashed border-primary/35" /><div className="h-4 flex-1 rounded-tr-lg border-r border-t border-dashed border-primary/35" /></div>
            <div className="flex w-full justify-between gap-3"><div className="flow-node flex flex-1 items-center gap-2 rounded-lg border bg-card p-2.5 shadow-sm"><span className="role-icon blue"><Bot className="size-4" /></span><div><p className="text-[10px] font-medium">Worker</p><p className="mt-0.5 text-[8px] text-muted-foreground">独立空间执行</p></div></div><div className="flow-node flex flex-1 items-center gap-2 rounded-lg border bg-card p-2.5 shadow-sm"><span className="role-icon green"><ShieldCheck className="size-4" /></span><div><p className="text-[10px] font-medium">Reviewer</p><p className="mt-0.5 text-[8px] text-muted-foreground">独立质量审阅</p></div></div></div>
            <div className="mt-5 flex items-center gap-1.5 text-[9px] text-muted-foreground"><span className="size-1 rounded-full bg-muted-foreground/50" />多 Agent 工作流 · 配置后启用</div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/25 px-6 py-3 text-[10px] text-muted-foreground"><span className="flex size-4 items-center justify-center rounded-full bg-success/10 text-success"><Check className="size-2.5" /></span>{setup.database ? "Neon 数据库已连接" : "等待连接数据库"}<span className="mx-1 opacity-40">/</span><span>下一步：完成账号与编辑器配置</span><button onClick={() => open("setup")} className="ml-auto flex items-center gap-1 font-medium text-foreground hover:text-primary">查看配置<ArrowRight className="size-3" /></button></div>
    </section>
    <section aria-label="工作空间统计" className="grid grid-cols-2 gap-5 border-b pb-6 sm:grid-cols-4">
      {[{ title: "待处理任务", icon: Circle, label: "等待第一个想法" }, { title: "进行中", icon: GitBranch, label: "还没有运行中的任务" }, { title: "等待审阅", icon: ShieldCheck, label: "交付前的最后一站" }, { title: "已完成", icon: CheckCheck, label: "每一步进展都值得记录" }].map((item, i) => <div key={item.title} className="flex flex-col gap-2.5"><div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><item.icon className="size-3.5" />{item.title}</div><div className="flex items-baseline gap-2"><span className="text-[27px] font-medium leading-none tracking-tight">—</span><span className="text-[10px] text-muted-foreground">尚未开始</span></div><span className="text-[10px] text-muted-foreground/80">{item.label}</span></div>)}
    </section>
    <div className="grid gap-7 xl:grid-cols-[1.12fr_1fr]">
      <section aria-labelledby="workspace-steps"><div className="mb-4 flex items-center justify-between"><h2 id="workspace-steps" className="flex items-center gap-2 text-xs font-semibold"><Layers3 className="size-3.5 text-muted-foreground" />搭建你的工作空间</h2><span className="text-[10px] text-muted-foreground">1 / 4 已就绪</span></div>
        <div className="flex flex-col">{[
          { icon: Database, title: "连接持久化存储", desc: "Neon 已连接，准备承载项目与任务", done: setup.database, action: "setup" },
          { icon: LockKeyhole, title: "创建你的工作空间", desc: "设置账号、团队与成员权限", done: false, action: "workspace" },
          { icon: Terminal, title: "连接本机 Claude", desc: "通过 Node.js daemon 安全执行", done: false, action: "connection" },
          { icon: Workflow, title: "创建第一条工作流", desc: "定义分配、执行与审阅规则", done: false, action: "automation" },
        ].map((step, i) => <button key={step.title} onClick={() => open(step.action as ModalKind)} className="group flex items-center gap-3 border-b border-border/70 py-3.5 text-left last:border-0"><span className={step.done ? "flex size-7 shrink-0 items-center justify-center rounded-full bg-success/10 text-success" : "flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground"}>{step.done ? <Check className="size-3.5" /> : <step.icon className="size-3.5" />}</span><span><span className="block text-[11px] font-medium">{step.title}</span><span className="mt-1 block text-[10px] text-muted-foreground">{step.desc}</span></span>{step.done ? <span className="ml-auto text-[10px] text-success">已连接</span> : <ArrowUpRight className="ml-auto size-3.5 text-muted-foreground transition-colors group-hover:text-primary" />}</button>)}</div>
      </section>
      <section aria-labelledby="recent-activity"><div className="mb-4 flex items-center justify-between"><h2 id="recent-activity" className="text-xs font-semibold">最近活动</h2><button onClick={() => navigate("activity")} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">查看全部<ArrowUpRight className="size-3" /></button></div><div className="activity-placeholder flex min-h-[242px] flex-col items-center justify-center rounded-lg border border-dashed bg-muted/15 px-6 text-center"><div className="mb-4 flex items-end gap-1.5 text-muted-foreground/45" aria-hidden="true">{[14, 22, 32, 20, 38, 28, 17].map((h, i) => <span key={i} style={{ height: h }} className="w-1 rounded-full bg-current" />)}</div><p className="text-[11px] font-medium">每一份进展，都有迹可循</p><p className="mt-2 max-w-[240px] text-[10px] leading-5 text-muted-foreground">任务更新、Agent 执行和团队讨论，<br />将在这里汇聚成完整的时间线。</p><button onClick={() => open("issue")} className="mt-4 flex items-center gap-1 text-[10px] font-medium text-primary">从创建任务开始<ArrowRight className="size-3" /></button></div></section>
    </div>
    <footer className="flex flex-wrap items-center gap-2 pb-2 text-[9px] text-muted-foreground/75"><Command className="size-3" /><span>Orbit · 与你的 Agent，一起向前。</span><span className="ml-auto hidden items-center gap-3 sm:flex"><span><kbd className="rounded border px-1">C</kbd> 新建任务</span><span><kbd className="rounded border px-1">⌘ K</kbd> 快速跳转</span></span></footer>
  </div>
}
