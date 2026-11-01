// Bot chats for the demo workspace. Each entry is one AI SDK model message,
// stored as a coordinator_messages row of that bot (lib/coordinator/context.ts
// reads them). Assistant text that has a `root = …` line renders as OpenUI
// (lib/agent-ui-source.ts); anything else renders as Markdown.
// Placeholders the seed replaces: {{issue:<key>}} and {{run:<key>}} with row ids.

const user = content => ({ role: 'user', content })
const bot = content => ({ role: 'assistant', content: [{ type: 'text', text: content }] })
/** An assistant turn that used tools; stored rows only list the tool names under the reply. */
const botWithTools = (text, tools) => ({ role: 'assistant', content: [...tools.map(toolName => ({ type: 'tool-call', toolCallId: `call_${toolName}`, toolName, input: {} })), { type: 'text', text }] })
const toolResult = (toolName, value) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `call_${toolName}`, toolName, output: { type: 'json', value } }] })

// A 1×1 PNG, enough for the chat's image count on a user message.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export const CHATS = {
  frontend: [
    user('看板在 13 寸上最后一张卡被横向滚动条挡住了，你看下 {{issue:i-board-scroll}}'),
    botWithTools('看了，是列内容区 `overflow-y-auto` 的底部没有给横向滚动条留空间。Windows 和 macOS「始终显示滚动条」时都会遮住约 12px。\n\n我已经开了线程去改，只动内容区的 padding，不碰 300px 列宽（R-25）。', ['get_issue', 'dispatch_run']),
    toolResult('dispatch_run', { runId: '{{run:r-board-scroll}}' }),
    user([{ type: 'text', text: '这是我这边的截图，「已完成」那列' }, { type: 'file', mediaType: 'image/png', data: PIXEL }]),
    bot('收到截图，和我复现的一致。改动是这一处：\n\n```tsx\n// components/blocks/kanban-board-1/components/kanban-board.tsx\n<KanbanColumnContent\n  value={column.value}\n  className="min-h-0 flex-1 gap-1.5 overflow-y-auto overscroll-y-contain p-0.5 pb-[var(--scrollbar-size)]"\n/>\n```\n\n`--scrollbar-size` 在 `globals.css` 里按平台给值，macOS 叠加滚动条时是 0，不会多出空白。'),
    user('顺便把这周前端相关的 PR 状态列一下'),
    bot(`root = Stack([title, table])
title = TextContent("前端相关 PR（本周）", "large-heavy")
table = BeTable(["PR", "标题", "状态", "评审"], [["#845", "看板最后一张卡避开滚动条", "Open", "等 CI"], ["#851", "引用保留 Artifact 版本", "Open", "1 条意见"], ["#790", "半透明窗口去掉对话框模糊", "Merged", "通过"], ["#781", "旧组件名继续解析", "Merged", "通过"]])`),
    user('#851 的意见是什么？'),
    bot(`root = Stack([intro, diff, alert])
intro = InlineText(["评审在 ", SourceChip("https://github.com/mikka-demo/web/pull/851", "PR #851"), " 里指出：引用对象里的 version 用的是字符串，", TaskChip("{{issue:i-quote-artifact}}"), " 的根因其实在序列化那一层。"])
diff = BeFileDiff("lib/artifacts/quote.ts", "-  version: String(selection.version ?? ''),\\n+  version: selection.version,\\n   kind: selection.kind,", "tsx")
alert = BeAlert("还需要一个迁移？", "不需要：历史消息里空的 version 会按最新版处理，和现在行为一致。", "info")`),
  ],

  backend: [
    user('群聊同时 @ 三个 Bot 只有第一个回复，你查一下'),
    botWithTools('查了 `group_turns`：每条消息只排了一个 turn，`route.botIds` 只取了第一个提及。这是 #640 改问题卡流程时顺手改坏的。\n\n复现条件很窄：必须在**同一条**消息里提及 3 个及以上 Bot，两个时走的是另一条分支，所以测试没覆盖到。', ['search_issues', 'read_file']),
    user('多久能修？顺便估一下影响面'),
    bot(`root = Stack([stats, chart, steps])
stats = Stack([BeStat("近 7 天受影响消息", 37, "条", 0), BeStat("涉及群聊", 5, "个", 0), BeStat("预计修复", 0.5, "天", 1)], "row")
chart = BarChart(["周一", "周二", "周三", "周四", "周五"], [{name: "多提及消息", values: [4, 9, 6, 11, 7]}, {name: "只回复一个", values: [4, 9, 6, 11, 7]}])
steps = Steps([StepsItem("补测试", "三个提及各自一个 turn"), StepsItem("修路由", "route.botIds 保留全部提及"), StepsItem("回放", "对这 37 条消息补发给漏掉的 Bot？需要你确认")])`),
    user('回放先别做，可能会吵到人'),
    bot('好，不回放。只修路由和补测试，线程已经在跑：{{run:r-group-route}}。\n\n合并前我会在描述里写清楚「历史消息不补发」。'),
    user('昨天的 E2B 429 是怎么回事'),
    bot(`root = Stack([tabs])
tabs = BeTabs([{title: "现象", children: [TextContent("E2B 返回 429 后 dispatch 一直重试，线程停在「准备中」。")]}, {title: "日志", children: [BeCodeBlock("2026-10-31T14:02:11Z dispatch run=7f3c… sandbox.create 429 Too Many Requests\\n2026-10-31T14:02:41Z dispatch run=7f3c… retry 1/∞\\n2026-10-31T14:03:11Z dispatch run=7f3c… retry 2/∞", "text", "dispatch.log", [2, 3])]}, {title: "建议", children: [BeTodoList("修复计划", [{id: "a", title: "429 计入失败，最多重试 1 次", status: "in-progress"}, {id: "b", title: "失败时给出更换 Key 的卡片", status: "pending"}, {id: "c", title: "监控 429 比例", status: "pending"}], "suggestion")]}])`),
  ],

  daemon: [
    user('daemon 的 CI 又红了，还是 sandbox verify 超时吗'),
    botWithTools('是。最近 20 次 main 构建失败 4 次，全部是 `daemon/sandbox.verify.test.ts`。本地 `--repeat 50` 能稳定复现：verify 在 `git config` 写完之前就读了配置。', ['list_runs', 'read_file', 'run_command']),
    bot(`root = Stack([line, collapse])
line = LineChart(["10/25", "10/26", "10/27", "10/28", "10/29", "10/30", "10/31"], [{name: "失败率", values: [0, 5, 10, 15, 20, 20, 25]}], "%")
collapse = BeCollapsible("失败用例明细", [BeTable(["构建", "用例", "耗时"], [["#4412", "verify > rejects dirty tree", "30.0s 超时"], ["#4418", "verify > rejects dirty tree", "30.0s 超时"], ["#4431", "verify > accepts clean tree", "30.0s 超时"], ["#4440", "verify > rejects dirty tree", "30.0s 超时"]])], false)`),
    user('修复方案给我看一下'),
    bot(`root = Stack([tree, diff, approve])
tree = BeFileTree(["daemon/src/sandbox/verify.ts", "daemon/src/sandbox/git-config.ts", "daemon/test/sandbox.verify.test.ts"])
diff = BeFileDiff("daemon/src/sandbox/verify.ts", "-  void writeGitConfig(dir, identity)\\n+  await writeGitConfig(dir, identity)\\n   const status = await git(dir, ['status', '--porcelain'])", "tsx")
approve = BeApproval("合并 #61 到 main？", "改动只有一行 await，外加把测试里的固定 sleep 去掉。", "mikka-demo/daemon#61")`),
    user('可以，合吧'),
    bot('已提交合并请求，等 CI 跑完会自动合。线程在这里：{{run:r-flaky-daemon}}'),
  ],

  qa: [
    user('今天的回归巡检结果？'),
    bot(`root = Stack([alert, donut, radial, list])
alert = BeAlert("2 个失败", "登录死循环仍可复现；iOS 冷启动白屏 2 秒。", "destructive")
donut = DonutChart([{name: "通过", value: 46}, {name: "失败", value: 2}, {name: "跳过", value: 3}], "个", "用例")
radial = RadialChart("本月 E2E 时长额度", 312, 500, "分钟")
list = BeTodoList("待跟进", [{id: "1", title: "登录死循环：等 handoff 修复", status: "pending", detail: "APP 任务，紧急"}, {id: "2", title: "冷启动白屏：已有线程在跑", status: "in-progress", progress: 40}, {id: "3", title: "离线横幅：无法稳定复现", status: "cancelled"}])`),
    user('登录死循环那个能给我复现步骤吗'),
    bot('复现步骤（桌面版 0.9.4，macOS 26.1）：\n\n1. 退出登录。\n2. 点「用浏览器登录」。\n3. 在浏览器授权页点**拒绝**。\n4. 回到桌面端：登录页闪一下又打开浏览器，无限循环。\n\n关键日志：\n\n```text\n[auth] handoff refused state=9c1e…\n[auth] no session, starting handoff\n[auth] handoff refused state=a42b…\n```\n\n任务：{{issue:i-signin-loop}}。失败的那次线程：{{run:r-signin-loop}}。'),
    user('哪些页面最近改动最大，巡检要加重'),
    bot(`root = Stack([area, cards])
area = AreaChart(["第 41 周", "第 42 周", "第 43 周", "第 44 周"], [{name: "看板", values: [3, 8, 12, 9]}, {name: "聊天", values: [6, 7, 15, 18]}, {name: "设置", values: [2, 4, 3, 6]}], "个 PR")
cards = BeCard("建议加重", [TextContent("聊天（OpenUI 卡片、引用、图片）和看板（R-25 卡片）。设置页改动小，保持冒烟即可。"), Separator(), Tag("聊天", null, "sm", "info"), Tag("看板", null, "sm", "success")], "按最近四周合入的 PR 数")`),
  ],

  release: [
    user('这周五能发桌面 0.9.5 吗'),
    bot(`root = Stack([intro, questions])
intro = TextContent("发版前有两个阻塞和一个待定项，需要你先定几件事。")
questions = BeQuestions("0.9.5 发版准备", [{id: "scope", title: "登录死循环没修完，要不要等？", options: [{value: "wait", label: "等修复再发", description: "可能推迟到下周二"}, {value: "ship", label: "照常发，下个版本修"}]}, {id: "channels", title: "发布渠道", options: [{value: "stable", label: "Stable"}, {value: "beta", label: "Beta"}], multiple: true}, {id: "rollout", title: "首日灰度比例", input: "slider", range: {min: 5, max: 100, step: 5, unit: "%"}}, {id: "notes", title: "发版说明额外要写的", allowCustom: true}])`),
    user('等修复再发，只发 Beta，灰度 20%'),
    bot(`root = Stack([timeline, form])
timeline = Steps([StepsItem("周三", "登录死循环修复合入"), StepsItem("周四", "Beta 构建、签名、公证"), StepsItem("周五 10:00", "Beta 20% 灰度"), StepsItem("下周一", "看崩溃率决定是否全量")])
form = Form("release-checklist", Buttons([Button("确认这份清单", Action([@ToAssistant("确认 0.9.5 Beta 发版清单")]), "primary")]), [FormControl("发版检查项", EditableTable("checklist", [{type: "text", key: "item", header: "检查项"}, {type: "text", key: "owner", header: "负责人"}], [{id: "1", values: ["SBOM 跳过未安装的可选包"]}, {id: "2", values: ["macOS 26 图标全尺寸"]}, {id: "3", values: ["自动更新回滚演练"]}]))])`),
    user('发版说明先写个草稿'),
    bot('草稿已经写成 Artifact，你可以直接在里面圈改：[[artifact:{{artifact:a-release-notes}}]]\n\n要点：\n\n- 修复：拒绝浏览器授权后登录页循环\n- 修复：半透明窗口下对话框背后的模糊\n- 改进：后台下载更新，头像上方出现「重启以更新」'),
  ],

  mobile: [
    user('TestFlight 冷启动白屏的线程现在什么状态'),
    bot(`root = Stack([computer, note])
computer = ComputerCard("{{bot:mobile}}", "{{run:r-testflight}}", "在模拟器里冷启动 20 次，记录首帧时间，并对比改动前后。", "approval", "iOS 客户端", "TestFlight 冷启动白屏")
note = InlineText(["线程 ", RunChip("{{run:r-testflight}}"), " 在等你确认：要不要把 SecureStore 的读取挪到首帧之后。"])`),
    user('挪吧，但登录态要先读'),
    bot('明白：先读登录 token（一个 key），其他偏好在首帧后补。我已经把这句话转给线程。\n\n首帧时间对比（模拟器，20 次中位数）：\n\n| | 改动前 | 改动后 |\n|---|---|---|\n| 冷启动首帧 | 2.1s | 0.6s |\n| 热启动首帧 | 0.4s | 0.3s |'),
    user('冷启动回归要覆盖哪几台测试机？'),
    bot(`root = Stack([grid, image, buttons])
grid = BeCardGrid([BeImageCard("iPhone 13", "iPhone 13", "主力机型，冷启动基线在这台上量。", ["基线"]), BeImageCard("iPhone SE", "iPhone SE 2020", "小屏和老芯片，白屏最明显。", ["小屏", "A13"]), BeImageCard("iPad Air", "iPad Air 2020", "确认分栏布局下首帧也正常。", ["平板"])])
image = BeImage("MacBook Pro 2021", "跑模拟器的 MacBook Pro", "公共图库示意图")
buttons = Stack([BeButton("继续细化", "把三台测试机的首帧时间做成表格", "primary"), BeButton("直接提问", "iPhone SE 上还需要测热启动吗？", "outline")], "row")`),
  ],

  docs: [
    user('R-40 文案规则能给新人讲清楚吗？'),
    bot(`root = BeResponse([TextContent("R-40：界面上没有填充语。"), BeCard("三条判断", [TextContent("1. 删掉这句，屏幕还在说同一件事 → 删。"), TextContent("2. 对话框和弹层没有副标题。"), TextContent("3. 安心感用标记表达（🔒 Secured by Mikka），不用句子。")], "评审时逐条过"), BeCitations([{title: "docs/design/rules.md", url: "https://github.com/mikka-demo/web/blob/main/docs/design/rules.md"}, {title: "docs/review-checklist.md", url: "https://github.com/mikka-demo/web/blob/main/docs/review-checklist.md"}])])`),
    user('给几个反例'),
    bot(`root = Stack([icon, table])
icon = AgentIcon("source", "反例来自最近被打回的 PR")
table = BeTable(["原文案", "问题", "改成"], [["正在为你加载数据，请稍候…", "状态行只写状态", "加载中"], ["别担心，你的数据很安全", "安心感用标记", "🔒 Secured by Mikka"], ["在这里你可以管理所有成员", "删掉后意思不变", "（删除）"]])`),
    user('把这三条加进评审清单'),
    bot('已经加进 `docs/review-checklist.md` 的「文案」一节，并标注了出处 R-40。下次评审我会按这三条过一遍。'),
  ],
}

/** The group chat: humans and bots talking about the Friday release. */
export const GROUP = {
  key: 'g-release',
  title: '0.9.5 发版群',
  bots: ['release', 'frontend', 'backend', 'qa'],
  people: ['lin', 'zhou'],
  messages: [
    { by: 'me', body: '周五发 0.9.5 Beta，大家同步一下各自的阻塞', mentions: [] },
    { by: 'bot:release', body: '目前两个阻塞：登录死循环（APP，紧急）和流式中断不记账。前者由 林晓 跟，后者在评审。' },
    { by: 'lin', body: '登录死循环我今天下午能提 PR，handoff 拒绝分支已经定位到了' },
    { by: 'me', body: '@QA 巡检 @Mikka Frontend 修完之后各自回归一遍', mentions: ['bot:qa', 'bot:frontend'] },
    { by: 'bot:qa', body: '收到。合入后我跑一遍桌面登录相关的 6 个用例，结果发群里。' },
    { by: 'bot:frontend', body: '收到。我这边看板滚动条的 PR 也会在周四前合，不会影响发版。' },
    { by: 'zhou', body: '计费那个我再看一眼，迁移顺序没问题的话今晚就合' },
    { by: 'bot:backend', body: '迁移时间戳我核对过，排在 main 最新一条之后，可以合。' },
  ],
}
