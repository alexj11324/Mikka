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

export const AGENT_DEMO_SECTIONS = [
  {
    id: 'rich-text', title: '富文本与数学公式', description: '与真实回复共用 Markdown 渲染器：标题、列表、引用、表格、链接、行内代码和 KaTeX。',
    response: `root = BeResponse([${content('## 从需求到可交付成果\n\n这是一段 **加粗重点**、*强调文字* 和 `summarize()` 行内代码。\n\n- 普通列表：支持结构化说明\n- [x] 已确认范围（演示）\n- [ ] 完成设计评审（演示）\n\n1. 明确目标\n2. 拆分工作\n3. 检查交付物\n\n> 演示中的数据和进度均为虚构，不会写入工作区。\n\n| 阶段 | 交付物 |\n| --- | --- |\n| 发现 | 需求清单 |\n| 设计 | 交互原型 |\n\n参考 [Markdown 指南](https://www.markdownguide.org/)。\n\n### 数学公式\n\n$$\nP(\\text{完成}) = \\frac{n_{\\text{已完成}}}{n_{\\text{全部}}} = \\frac{3}{5} = 60\\%\n$$\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$')}])`,
  },
  {
    id: 'diagrams', title: 'Mermaid 图表与代码围栏', description: '流程图和时序图自动渲染；代码围栏直接使用 beUI Code Block。',
    response: `root = Stack([BeCodeBlock(${JSON.stringify(AGENT_DEMO_CODE)}, "typescript", "示例函数.ts", [4]), ${content('```mermaid\nflowchart LR\nA(提出需求) --> B(整理计划):::focus\nB --> C{确认方案}:::warning\nC -->|同意| D(准备交付):::success\nC -->|修改| B\n```')}, ${content('```mermaid\nsequenceDiagram\n参与者->>助手: 选择演示内容\n助手-->>参与者: 本地渲染组件\nNote over 参与者,助手: 不请求模型\n```')}, ${content('```python\ndef completion_rate(done, total):\n    return done / total if total else 0\n```\n\n```\n不指定语言的单行代码也使用 beUI Code Block\n```')}])`,
  },
  {
    id: 'cards', title: '卡片、指标与图片', description: 'beUI 卡片、动态数字、状态标签、图文网格与图片查看器。图片使用本地演示占位图。',
    response: `root = Stack([BeCard("演示项目摘要", [BeBadge("演示数据", "info"), AgentIcon("assistant", "组件由本地样例自动组合"), BeStat("已完成示例任务", 3, "项", 0), BeButton("继续细化", "演示：细化项目摘要", "outline")], "这里展示的是样例，不是真实项目数据。"), BeCardGrid([BeImageCard("需求工作坊", "Demo workshop", "梳理问题、边界与交付物。", ["演示占位图", "需求"], "演示：了解需求工作坊"), BeImageCard("设计评审", "Demo design", "讨论原型并收集反馈。", ["演示占位图", "设计"], "演示：了解设计评审")]), BeImage("Demo illustration", "演示资料配图", "本地占位图，仅用于查看图片组件效果。")])`,
  },
  {
    id: 'decisions', title: '计划、审批与多步骤提问', description: '可操作的建议确认、单选、多选和自定义回答。所有提交仅反馈到本演示。',
    response: `root = Stack([BeTodoList("建议计划（演示）", [{id:"discover", title:"整理需求", detail:"只展示建议，不执行任务。"}, {id:"design", title:"评审设计"}], "suggestion"), BeTodoList("状态效果（演示数据）", [{id:"one", title:"需求整理", status:"completed"}, {id:"two", title:"原型设计", status:"in-progress", progress:60}, {id:"three", title:"交付检查", status:"pending"}], "user"), BeApproval("确认示例方案", "先整理需求，再准备交互原型。选择后仅产生演示反馈。", "纯本地组件演示，不执行或保存任何操作。"), BeQuestions("纯本地组件演示", [{id:"scope", title:"希望先体验哪个部分？", options:[{value:"content", label:"富文本与代码"}, {value:"cards", label:"卡片与交互"}], allowCustom:true}, {id:"checks", title:"需要查看哪些效果？", options:[{value:"motion", label:"动效"}, {value:"mobile", label:"移动端布局"}], multiple:true, allowCustom:true}]), BeFollowUps([{label:"如何组合这些组件？", prompt:"演示：组合组件"}, {label:"代码块有哪些功能？", prompt:"演示：代码块功能"}])])`,
  },
  {
    id: 'ui', title: 'shadcn、REUI 与数据图表', description: '折叠面板、标签页、表格、进度条和 OpenUI 数据图表，均使用固定演示数据。',
    response: `root = Stack([ShadcnCard("交付检查（演示）", [ShadcnBadge("待评审", "secondary"), ShadcnAlert("仅供预览", "这些内容不代表真实任务状态。"), ShadcnProgress("示例进度", 60), ShadcnTable(["项目", "数量"], [["已完成", "3"], ["待完成", "2"]]), ShadcnButton("继续细化", "演示：继续完善交付检查", "outline")], "shadcn 本地组件"), ShadcnTabs([{title:"概览", children:[${content('标签页内同样支持 **Markdown**。')}]}, {title:"说明", children:[${content('这是第二个标签页，可自由切换。')}]}]), ShadcnAccordion([{title:"这些数据来自模型吗？", content:"不是，演示使用预设样例。"}, {title:"会保存演示操作吗？", content:"不会，退出或重播即可重置演示。"}], true), ReuiFrame("REUI 示例", [ReuiBadge("示例标签", "info-light"), ReuiAlert("本地反馈", "此面板仅展示组件样式。", "info")], "与工作区共享主题"), BarChart(["需求", "设计", "检查"], [Series("示例完成数", [3, 2, 1])], "grouped", "阶段", "数量", 240)])`,
  },
] as const
