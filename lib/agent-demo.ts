import type { CitationSource } from './coordinator/citations'

const content = (text: string) => `TextContent(${JSON.stringify(text)})`

export const AGENT_DEMO_CODE = [
  'type Task = { title: string; completed: boolean }',
  '',
  'export function summarize(tasks: Task[]) {',
  '  const completed = tasks.filter(task => task.completed).length',
  '  return {',
  '    total: tasks.length,',
  '    completed,',
  '    progress: tasks.length ? completed / tasks.length : 0,',
  '  }',
  '}',
].join('\n')

export const AGENT_DEMO_MATH = String.raw`

### 行内公式与复杂排版

行内公式：$$E = mc^2$$，以及根式 $$\sqrt{a^2+b^2}$$；它们应与正文在同一行。

多行等式：

$$
\begin{aligned}
f(x) &= (x+1)^2 \\
     &= x^2 + 2x + 1
\end{aligned}
$$

矩阵与定界符：

$$
A = \begin{pmatrix} a & b \\ c & d \end{pmatrix},
\qquad \det(A) = ad-bc
$$

长公式在窄屏中可横向滚动，不应裁掉开头或撑宽整个页面：

$$
\operatorname{Attention}(Q,K,V) = \operatorname{softmax}\!\left(\frac{QK^{\mathsf{T}}}{\sqrt{d_k}} + M\right)V,
\qquad Q,K \in \mathbb{R}^{n\times d_k},\quad V \in \mathbb{R}^{n\times d_v}
$$
`

const DEMO_TASK = '00000000-0000-4000-8000-000000000043'
const DEMO_TASK_2 = '00000000-0000-4000-8000-000000000044'
const DEMO_RUN = '00000000-0000-4000-8000-0000000000a1'

/** The tasks and run the citation demo cites, as a conversation would look them up. */
export const AGENT_DEMO_CITATIONS: Record<string, CitationSource> = {
  [DEMO_TASK]: { kind: 'issue', id: DEMO_TASK, number: 43, identifier: 'MIK-43', title: '演示任务：Coordinator 聊天迁到 OpenUI', status: 'doing', priority: 'high' },
  [DEMO_TASK_2]: { kind: 'issue', id: DEMO_TASK_2, number: 44, identifier: 'MIK-44', title: '演示任务：任务与来源 chip 注册为 OpenUI 组件', status: 'todo', priority: 'medium' },
  [DEMO_RUN]: { kind: 'run', id: DEMO_RUN, agentName: 'Worker', harness: 'claude_code', status: 'running', issue: { id: DEMO_TASK, number: 43, identifier: 'MIK-43', title: '演示任务：Coordinator 聊天迁到 OpenUI' }, name: '演示任务：Coordinator 聊天迁到 OpenUI', summary: null, steps: 12, createdAt: '2026-10-23T14:00:00.000Z', finishedAt: null },
}

export const AGENT_DEMO_SECTIONS = [
  {
    id: 'rich-text', title: '富文本与数学公式', description: '与真实回复共用 Markdown 渲染器：标题、列表、引用、表格、链接、行内代码和 KaTeX。',
    response: `root = BeResponse([${content('## 从需求到可交付成果\n\n这是一段 **加粗重点**、*强调文字* 和 `summarize()` 行内代码。\n\n- 普通列表：支持结构化说明\n- [x] 已确认范围（演示）\n- [ ] 完成设计评审（演示）\n\n1. 明确目标\n2. 拆分工作\n3. 检查交付物\n\n> 演示中的数据和进度均为虚构，不会写入工作区。\n\n| 阶段 | 交付物 |\n| --- | --- |\n| 发现 | 需求清单 |\n| 设计 | 交互原型 |\n\n参考 [Markdown 指南](https://www.markdownguide.org/)。\n\n### 数学公式\n\n$$\nP(\\text{完成}) = \\frac{n_{\\text{已完成}}}{n_{\\text{全部}}} = \\frac{3}{5} = 60\\%\n$$\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$' + AGENT_DEMO_MATH)}])`,
  },
  {
    id: 'diagrams', title: 'Mermaid 图表与代码围栏', description: '流程图和时序图自动渲染；代码围栏直接使用 beUI Code Block。',
    response: `root = Stack([BeCodeBlock(${JSON.stringify(AGENT_DEMO_CODE)}, "typescript", "示例函数.ts", [4]), ${content('```mermaid\nflowchart LR\nA(提出需求) --> B(整理计划):::focus\nB --> C{确认方案}:::warning\nC -->|同意| D(准备交付):::success\nC -->|修改| B\n```')}, ${content('```mermaid\nsequenceDiagram\n参与者->>助手: 选择演示内容\n助手-->>参与者: 本地渲染组件\nNote over 参与者,助手: 不请求模型\n```')}, ${content('```python\ndef completion_rate(done, total):\n    return done / total if total else 0\n```\n\n```\n不指定语言的单行代码也使用 beUI Code Block\n```')}])`,
  },
  {
    id: 'cards', title: '卡片、指标与图片', description: 'beUI 卡片、动态数字、OpenUI 状态标签、图文网格与图片查看器。图片使用本地演示占位图。',
    response: `root = Stack([BeCard("演示项目摘要", [Tag("演示数据", null, "sm", "info"), AgentIcon("assistant", "组件由本地样例自动组合"), BeStat("已完成示例任务", 3, "项", 0), BeButton("继续细化", "演示：细化项目摘要", "outline")], "这里展示的是样例，不是真实项目数据。"), BeCardGrid([BeImageCard("需求工作坊", "Demo workshop", "梳理问题、边界与交付物。", ["演示占位图", "需求"], "演示：了解需求工作坊"), BeImageCard("设计评审", "Demo design", "讨论原型并收集反馈。", ["演示占位图", "设计"], "演示：了解设计评审")]), BeImage("Demo illustration", "演示资料配图", "本地占位图，仅用于查看图片组件效果。")])`,
  },
  {
    id: 'decisions', title: '计划、审批与多步骤提问', description: '可操作的建议确认、单选、多选和自定义回答。所有提交仅反馈到本演示。',
    response: `root = Stack([BeTodoList("建议计划（演示）", [{id:"discover", title:"整理需求", detail:"只展示建议，不执行任务。"}, {id:"design", title:"评审设计"}], "suggestion"), BeTodoList("状态效果（演示数据）", [{id:"one", title:"需求整理", status:"completed"}, {id:"two", title:"原型设计", status:"in-progress", progress:60}, {id:"three", title:"交付检查", status:"pending"}], "user"), BeApproval("确认示例方案", "先整理需求，再准备交互原型。选择后仅产生演示反馈。", "纯本地组件演示，不执行或保存任何操作。"), BeQuestions("纯本地组件演示", [{id:"scope", title:"希望先体验哪个部分？", options:[{value:"content", label:"富文本与代码"}, {value:"cards", label:"卡片与交互"}], allowCustom:true}, {id:"checks", title:"需要查看哪些效果？", options:[{value:"motion", label:"动效"}, {value:"mobile", label:"移动端布局"}], multiple:true, allowCustom:true}]), BeFollowUps([{label:"如何组合这些组件？", prompt:"演示：组合组件"}, {label:"代码块有哪些功能？", prompt:"演示：代码块功能"}])])`,
  },
  {
    id: 'citations', title: '任务、运行、来源 chip 与电脑卡片', description: '任务显示状态点、编号和标题，运行和网页显示为来源 chip；都跟着正文排，一行放不下时整体换到下一行。电脑卡片显示一句任务和 bot 电脑的画面。',
    response: `root = Stack([line, wrap, computer, ${content(`Markdown 正文里的引用同样显示为 chip：[[issue:${DEMO_TASK_2}]]，参考 [OpenUI 文档](https://www.openui.com/docs)。`)}])
line = InlineText(["已派给 ", RunChip("${DEMO_RUN}"), " 处理 ", TaskChip("${DEMO_TASK}"), "，完成后接着做 ", TaskChip("${DEMO_TASK_2}"), "。PR：", SourceChip("https://github.com/alexj11324/Mikka/pull/92", "Mikka#92"), "。"])
wrap = InlineText(["这一句故意写得比较长，用来看换行效果：引用 ", TaskChip("${DEMO_TASK}"), " 放在行尾放不下时，会和后面的文字一起换到下一行，而不是单独占一行。"])
computer = ComputerCard("demo-done", "${DEMO_RUN}", "打开 #66 的预览部署，用测试账号登录，截一张首页。", "done", "Mikka Frontend", "#66 预览部署检查")`,
  },
  {
    id: 'ui', title: 'OpenUI 组件与批量核对', description: '状态标签、步骤、额度进度、排行和可编辑表格，均使用固定演示数据。',
    response: `root = Stack([tags, steps, quota, ranking, review])
tags = Stack([Tag("进行中", null, "sm", "warning"), Tag("已完成", null, "sm", "success"), Tag("待评审", null, "sm", "info"), Tag("失败", null, "sm", "danger")], "row", "s")
steps = Steps([StepsItem("11月2日 · 需求确认", "整理范围与验收标准。"), StepsItem("11月9日 · 设计评审", "建议日期"), StepsItem("11月16日 · 交付检查", "核对交付物。")])
quota = ShadcnProgress("本月额度（演示）", 60)
ranking = BarChart(["Alex", "Sam", "Lee", "Kim"], [{name: "完成", values: [9, 7, 4, 2]}], true, "项")
review = Form("tasks", Buttons([Button("创建这 3 个任务", Action([@ToAssistant("演示：按表格创建这些任务")]), "primary")]), [FormControl("任务", EditableTable("tasks", [{type: "text", key: "title", header: "标题"}, {type: "select", key: "priority", header: "优先级", options: [{value: "high", label: "高"}, {value: "low", label: "低"}]}, {type: "date-single", key: "due", header: "截止"}], [{id: "1", values: ["整理需求", "high", "2026-11-02"]}, {id: "2", values: ["评审设计", "low", "2026-11-09"]}, {id: "3", values: ["交付检查", "low", "2026-11-16"]}]))])`,
  },
  {
    id: 'report', title: 'beUI 报告与图表', description: '提示、可排序表格、柱状图、折线图、步骤、折叠区、标签页、文件树、来源与建议修改，均使用固定演示数据。',
    response: `root = Stack([alert, stats, table, bars, trend, stack, share, divider, timeline, more, tabs, tree, sources, diff])
alert = BeAlert("示例数据", "以下数字均为演示数据，不代表真实项目。", "info")
stats = BeCardGrid([BeStat("本周完成", 12, "项"), BeStat("平均耗时", 3.4, "天", 1)])
table = BeTable(["阶段", "完成", "负责人"], [["需求", 5, "Alex"], ["设计", 3, "Sam"], ["检查", 4, "Lee"]])
bars = BarChart(["需求", "设计", "检查"], [{name: "本周", values: [5, 3, 4]}, {name: "上周", values: [4, 4, 2]}], false, "项")
trend = LineChart(["周一", "周二", "周三", "周四", "周五"], [{name: "完成数", values: [1, 3, 2, 4, 2]}], "项")
stack = AreaChart(["周一", "周二", "周三", "周四", "周五"], [{name: "完成", values: [1, 3, 2, 4, 2]}, {name: "新增", values: [2, 1, 3, 1, 2]}], "项")
share = DonutChart([{name: "需求", value: 5}, {name: "设计", value: 3}, {name: "检查", value: 4}], "项", "合计")
divider = Separator()
timeline = Steps([StepsItem("11月2日 · 需求确认", "整理范围与验收标准。"), StepsItem("11月9日 · 设计评审", "建议日期"), StepsItem("11月16日 · 交付检查", "核对交付物。")])
more = BeCollapsible("补充说明", [TextContent("折叠区只放补充内容。")])
tabs = BeTabs([{title: "概览", children: [TextContent("第一页")]}, {title: "细节", children: [TextContent("第二页")]}])
tree = BeFileTree(["app/page.tsx", "app/layout.tsx", "lib/report.ts"])
sources = BeCitations([{title: "OpenUI 文档", url: "https://www.openui.com/docs"}])
diff = BeFileDiff("lib/report.ts", "-const title = '旧标题'\\n+const title = '周报'", "tsx")`,
  },
] as const
