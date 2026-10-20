"use client"

import { useState } from "react"
import type { JSONContent } from "@tiptap/react"
import { CircleDashed, Command, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { IssueEditor } from "@/components/workspace/issue-editor"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"

export function IssueWorkspace() {
  const [title, setTitle] = useState("")
  const [content, setContent] = useState<JSONContent>()
  const { resolvedTheme, setTheme } = useTheme()
  return <div className="min-h-svh bg-background text-foreground">
    <header className="flex h-14 items-center justify-between border-b px-5 sm:px-8"><div className="flex items-center gap-3 text-xs"><Command className="size-4" /><span className="font-semibold">Orbit</span><span className="text-muted-foreground">/</span><span className="text-muted-foreground">任务编辑</span></div><div className="flex items-center gap-3"><Badge variant="outline">编辑器整合预览</Badge><Button variant="ghost" size="icon-sm" aria-label="切换明暗主题" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>{resolvedTheme === "dark" ? <Sun /> : <Moon />}</Button></div></header>
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><CircleDashed className="size-3.5" /><span>新建任务</span><Badge variant="secondary">未保存草稿</Badge></div>
      <FieldGroup><Field><FieldLabel htmlFor="task-title" className="sr-only">任务标题</FieldLabel><Input id="task-title" placeholder="需要完成什么？" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} className="h-12 border-0 px-0 text-2xl! font-semibold shadow-none focus-visible:ring-0" /></Field><div className="flex flex-wrap items-center gap-2"><NativeSelect aria-label="任务状态" defaultValue="todo" size="sm"><NativeSelectOption value="todo">待处理</NativeSelectOption><NativeSelectOption value="doing">进行中</NativeSelectOption><NativeSelectOption value="review">待审阅</NativeSelectOption><NativeSelectOption value="done">已完成</NativeSelectOption></NativeSelect><NativeSelect aria-label="任务优先级" defaultValue="normal" size="sm"><NativeSelectOption value="urgent">紧急优先级</NativeSelectOption><NativeSelectOption value="high">高优先级</NativeSelectOption><NativeSelectOption value="normal">普通优先级</NativeSelectOption><NativeSelectOption value="low">低优先级</NativeSelectOption></NativeSelect><Badge variant="outline">负责人未配置</Badge></div></FieldGroup>
      <IssueEditor content={content} onChange={setContent} />
      <div className="flex flex-wrap items-center justify-between gap-4 text-xs"><p className="max-w-2xl leading-6 text-muted-foreground">这是四种 ReUI 编辑能力的整合预览，未加入 AI。账号、任务保存、成员提及和实时共同编辑尚未接通，不会模拟保存成功或在线成员。</p><Button disabled>创建任务（待接入账号）</Button></div>
    </main>
  </div>
}
