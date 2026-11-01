// Bot chats: one AI SDK model message per coordinator_messages row of that bot
// (lib/coordinator/context.ts reads them). Assistant text with a `root = …`
// line renders as OpenUI (lib/agent-ui-source.ts); anything else is Markdown.
// Placeholders the seed replaces: {{issue:<key>}}, {{run:<key>}}, {{bot:<key>}}, {{artifact:<key>}}.

const user = content => ({ role: 'user', content })
const bot = content => ({ role: 'assistant', content: [{ type: 'text', text: content }] })
/** An assistant turn that used tools; stored rows only list the tool names under the reply. */
const botWithTools = (text, tools) => ({ role: 'assistant', content: [...tools.map(toolName => ({ type: 'tool-call', toolCallId: `call_${toolName}`, toolName, input: {} })), { type: 'text', text }] })
const toolResult = (toolName, value) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `call_${toolName}`, toolName, output: { type: 'json', value } }] })

// A 1×1 PNG: the chat shows an image count on the user's message.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export const CHATS = {
  frontend: [
    user('有客户说 Mac 上登录页一片空白，你看下 {{issue:i-safari-blank}}'),
    botWithTools('Safari 17.0–17.3 能复现，Chrome 正常。控制台报：\n\n```text\nSyntaxError: Invalid regular expression: invalid group specifier name\n```\n\n这是 lookbehind 正则，Safari 17.4 之前不支持。v2.3.2 里只有 `date-fns-tz` 从 3.0 升到了 3.1，大概率是它。我开线程去写一个能复现的 WebKit 用例。', ['get_issue', 'dispatch_run']),
    toolResult('dispatch_run', { runId: '{{run:r-safari}}' }),
    user([{ type: 'text', text: '这是客户发来的截图' }, { type: 'file', mediaType: 'image/png', data: PIXEL }]),
    bot('和我复现的一致。线程那边 CI 上 WebKit 没装上，失败了；根因我已经确认，写在 Artifact 里：[[artifact:{{artifact:a-safari-rca}}]]\n\n先发一个热修：把 `date-fns-tz` 锁回 3.0.1。\n\n```diff\n-    "date-fns-tz": "^3.1.0",\n+    "date-fns-tz": "3.0.1",\n```'),
    user('这周前端的 PR 都什么状态'),
    bot(`root = Stack([title, table])
title = TextContent("ledger-web 本周 PR", "large-heavy")
table = BeTable(["PR", "标题", "作者", "状态"], [["#488", "去掉 components/ui 的 barrel 导入", "前端助手", "CI 中"], ["#485", "导出 CSV 加 UTF-8 BOM", "前端助手", "待评审"], ["#479", "隐私政策链接 404", "王蕾", "已合并"], ["#471", "首页预加载首图、字体子集化", "前端助手", "已合并"]])`),
    user('#485 改了什么'),
    bot(`root = Stack([intro, diff, note])
intro = InlineText(["修 ", TaskChip("{{issue:i-csv-garbled}}"), "：Windows Excel 打开没有 BOM 的 CSV 会按 GBK 解析。见 ", SourceChip("https://github.com/qingning-tech/ledger-web/pull/485", "PR #485"), "。"])
diff = BeFileDiff("lib/export/csv.ts", "-  return rows.map(toLine).join('\\\\n')\\n+  return '\\\\uFEFF' + rows.map(toLine).join('\\\\r\\\\n')", "tsx")
note = BeAlert("顺带改了换行", "Excel 对 CRLF 更友好；Numbers 和 WPS 不受影响。", "info")`),
    user('好，#485 我下午看'),
    bot('好的。合并后我在 staging 上用 Windows Excel 再验一遍。'),
  ],

  backend: [
    user('Stripe 续费从昨天开始都没入账，怎么回事'),
    botWithTools('查了：昨天 14:20 起所有 `invoice.paid` webhook 都返回 400。\n\n```text\nStripeSignatureVerificationError: No signatures found matching the expected signature for payload.\n```\n\n昨天网关升级后，body 在到达我们之前就被解析成了 JSON，再序列化时字段顺序变了，签名自然对不上。陈予已经提了 PR，用原始 body 校验。', ['search_logs', 'read_file']),
    user('影响多少客户？修完之后漏掉的怎么补'),
    bot(`root = Stack([stats, chart, steps])
stats = Stack([BeStat("受影响事件", 186, "个", 0), BeStat("涉及客户", 171, "家", 0), BeStat("待补金额", 25308, "元", 0)], "row")
chart = BarChart(["14:00", "16:00", "18:00", "20:00", "22:00"], [{name: "invoice.paid 400", values: [12, 41, 47, 52, 34]}])
steps = Steps([StepsItem("合并 #216", "webhook 用 raw body 校验"), StepsItem("重放", "从 Stripe 事件列表重放 186 个失败事件（#218）"), StepsItem("核对", "对比 Stripe 与账本的订阅到期日")])`),
    user('开放平台那边米粒电商又在说 429'),
    bot(`root = Stack([tabs])
tabs = BeTabs([{title: "现象", children: [TextContent("米粒电商每分钟导入约 300 张订单，限流是每个 token 每分钟 60 次。")]}, {title: "日志", children: [BeCodeBlock("2026-10-31T09:12:03Z 429 POST /v1/orders token=tk_mili… limit=60/min\\n2026-10-31T09:12:03Z 429 POST /v1/orders token=tk_mili… limit=60/min\\n2026-10-31T09:12:04Z 429 POST /v1/orders token=tk_mili… limit=60/min", "text", "gateway.log", [1])]}, {title: "方案", children: [BeTodoList("建议", [{id: "a", title: "批量接口单独限流：600 次/分钟", status: "in-progress"}, {id: "b", title: "提供 POST /v1/orders:batch，一次 100 条", status: "pending"}, {id: "c", title: "429 响应里带 Retry-After", status: "pending"}], "suggestion")]}])`),
    user('先做 a 和 c'),
    bot('好，PR #214 先改成按路由分级限流，并在 429 里返回 `Retry-After`。`orders:batch` 放到下个迭代。'),
  ],

  ops: [
    user('月度报表这两天特别慢，客户在群里抱怨'),
    botWithTools('`/api/reports/monthly` 的 P95 从 1.2s 涨到了 8s。慢查询日志：\n\n```sql\nSELECT date_trunc(\'day\', created_at), sum(amount)\nFROM transactions\nWHERE account_id = $1 AND created_at >= $2 AND created_at < $3\nGROUP BY 1;\n-- Seq Scan on transactions  (rows=2104331)  7612 ms\n```\n\n`transactions` 上没有 `(account_id, created_at)` 的复合索引。上周数据量过了 200 万行，开始全表扫描。线程已经在 staging 上加索引对比：{{run:r-slow-report}}', ['query_metrics', 'read_slow_log']),
    bot(`root = Stack([line, collapse])
line = LineChart(["10/25", "10/26", "10/27", "10/28", "10/29", "10/30", "10/31"], [{name: "P95 (秒)", values: [1.2, 1.3, 1.8, 3.4, 5.9, 7.6, 8.1]}], "s")
collapse = BeCollapsible("最慢的 4 条查询", [BeTable(["查询", "次数/小时", "平均耗时"], [["monthly report aggregate", "1,240", "7.6s"], ["invoice list by account", "3,980", "820ms"], ["export csv", "96", "2.1s"], ["dashboard summary", "8,410", "140ms"]])], false)`),
    user('索引怎么加，会锁表吗'),
    bot(`root = Stack([tree, diff, approve])
tree = BeFileTree(["db/migrations/20261031_transactions_account_created_idx.sql", "src/reports/monthly.ts", "test/reports/monthly.test.ts"])
diff = BeFileDiff("db/migrations/20261031_transactions_account_created_idx.sql", "+CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_account_created_idx\\n+  ON transactions (account_id, created_at);", "diff")
approve = BeApproval("今晚 22:00 在生产执行？", "CONCURRENTLY 不锁写，预计 6 分钟；staging 上 P95 降到 0.9s。", "qingning-tech/ledger-api#217")`),
    user('Sentry 昨晚那个 amount 报错呢'),
    bot('`TypeError: Cannot read properties of undefined (reading \'amount\')`，昨晚 21:00 起每小时 200+ 次，全部来自没有任何收支记录的新账户：账单详情页默认取了 `transactions[0].amount`。\n\n已经建了任务 {{issue:i-sentry-spike}}，分给刘洋。修法是空列表时显示空状态，一行改动。'),
  ],

  data: [
    user('10 月的经营数据出来了吗'),
    bot(`root = Stack([alert, donut, radial, list])
alert = BeAlert("付费转化率下降", "10 月试用转付费 11.2%，比 9 月低 2.4 个点。主要发生在 Safari 白屏那两天。", "warning")
donut = DonutChart([{name: "基础版", value: 412}, {name: "专业版", value: 238}, {name: "团队版", value: 61}], "家", "付费客户")
radial = RadialChart("10 月 MRR 目标", 186000, 200000, "元")
list = BeTodoList("建议跟进", [{id: "1", title: "给白屏期间流失的试用用户发补偿邮件", status: "pending", detail: "约 140 人"}, {id: "2", title: "专业版定价页 A/B 测试", status: "in-progress", progress: 60}, {id: "3", title: "团队版年付折扣", status: "cancelled"}])`),
    user('哪些功能用得最多'),
    bot(`root = Stack([area, card])
area = AreaChart(["第 41 周", "第 42 周", "第 43 周", "第 44 周"], [{name: "记账", values: [52100, 53800, 55200, 54900]}, {name: "开发票", values: [8200, 8900, 9600, 11800]}, {name: "导出报表", values: [3100, 3300, 3500, 3700]}], "次")
card = BeCard("观察", [TextContent("开发票增长最快，第 44 周环比 +23%，和发票模板灰度时间吻合。导出报表平稳。"), Separator(), Stack([Tag("发票模板", null, "sm", "success"), Tag("需关注：导出报表慢", null, "sm", "warning")], "row")], "数据来自产品埋点，按周统计")`),
    user('把重复扣费的客户名单拉一下'),
    bot('10 月因 Stripe webhook 重放导致重复扣费的客户共 **3 家**：禾木咖啡、北岸花艺、小满烘焙，合计 597 元。退款单已经准备好，等你确认后由客服助手发邮件说明。'),
  ],

  release: [
    user('v2.4 周五能发吗'),
    bot(`root = Stack([intro, questions])
intro = TextContent("还有两个阻塞、一个待定项，需要你先定几件事。")
questions = BeQuestions("v2.4 发版", [{id: "ios", title: "iOS 16 冷启动崩溃还没修完，iOS 端要不要等？", options: [{value: "wait", label: "等修复一起发", description: "可能推到下周二"}, {value: "web-first", label: "Web 先发，iOS 下周"}]}, {id: "channels", title: "发布渠道", options: [{value: "web", label: "Web"}, {value: "ios", label: "App Store"}, {value: "android", label: "应用宝"}], multiple: true}, {id: "rollout", title: "iOS 首日灰度比例", input: "slider", range: {min: 5, max: 100, step: 5, unit: "%"}}, {id: "notes", title: "发版说明还要补充的", allowCustom: true}])`),
    user('Web 先发，iOS 下周；灰度 20%'),
    bot(`root = Stack([timeline, form])
timeline = Steps([StepsItem("周三", "冻结 main，打 v2.4.0-rc.1"), StepsItem("周四", "staging 回归、数据迁移演练"), StepsItem("周五 10:00", "Web 发布，迁移在低峰执行"), StepsItem("下周一", "看 Sentry 和工单量，决定 iOS 时间")])
form = Form("release-checklist", Buttons([Button("确认这份清单", Action([@ToAssistant("确认 v2.4 发版清单")]), "primary")]), [FormControl("发版检查项", EditableTable("checklist", [{type: "text", key: "item", header: "检查项"}, {type: "text", key: "owner", header: "负责人"}], [{id: "1", values: ["多币种迁移在生产快照上演练", "陈予"]}, {id: "2", values: ["Stripe webhook 修复已上线", "陈予"]}, {id: "3", values: ["回滚方案和开关", "Alex"]}]))])`),
    user('发版说明写个草稿'),
    bot('草稿在这里，可以直接在里面改：[[artifact:{{artifact:a-release-notes}}]]\n\n要点：\n\n- 多币种账户\n- 发票模板\n- iOS 桌面小组件（随 iOS 版本下周发）\n- 修复 CSV 乱码、支付宝状态不同步'),
  ],

  ios: [
    user('iOS 16 闪退那个线程现在什么情况'),
    bot(`root = Stack([computer, note])
computer = ComputerCard("{{bot:ios}}", "{{run:r-ios-crash}}", "在 iOS 16.4 模拟器上冷启动 10 次，抓崩溃日志。", "approval", "iOS 助手", "iOS 16 冷启动崩溃")
note = InlineText(["线程 ", RunChip("{{run:r-ios-crash}}"), " 在等你确认：要不要把 Keychain 读取挪到 didFinishLaunching 之后。"])`),
    user('挪吧，但登录态要先读出来'),
    bot('明白：登录 token 在 `application(_:didFinishLaunchingWithOptions:)` 里同步读，其余偏好设置延后到首帧之后。已经转给线程。\n\n```swift\n// AppDelegate.swift\nfunc application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: ...) -> Bool {\n    Session.shared.restoreToken()          // 只读这一项\n    DispatchQueue.main.async { Preferences.shared.load() }\n    return true\n}\n```'),
    user('回归要覆盖哪几台机器'),
    bot(`root = Stack([grid, image, buttons])
grid = BeCardGrid([BeImageCard("iPhone 13", "iPhone 13", "主力机型，iOS 17.6。", ["基线"]), BeImageCard("iPhone SE", "iPhone SE 2020", "iOS 16.7，这次崩溃的机型。", ["iOS 16", "小屏"]), BeImageCard("iPad Air", "iPad Air 2020", "确认分栏布局和小组件。", ["平板"])])
image = BeImage("MacBook Pro 2021", "跑模拟器和 Instruments 的 MacBook Pro", "公共图库示意图")
buttons = Stack([BeButton("继续细化", "把三台机器的冷启动时间整理成表格", "primary"), BeButton("直接提问", "iOS 15 还需要支持吗？", "outline")], "row")`),
    user('iPhone SE 那台在一鸣那里，让他明早测'),
    bot('好，已经在线程里@赵一鸣，明早 10 点前给结果。'),
  ],

  support: [
    user('禾木咖啡投诉这个月被扣了两次会员费，帮我起草回复'),
    bot(`root = BeResponse([TextContent("回复草稿："), BeCard("给禾木咖啡张老板", [TextContent("张老板您好，非常抱歉给您带来困扰。10 月 30 日我们的支付回调出现故障，系统在恢复时重复扣了一次专业版月费 199 元。"), TextContent("我们已经发起全额退款，预计 3–5 个工作日原路退回，同时为您的账户延长一个月专业版作为补偿。"), TextContent("如有任何问题，直接回复这封邮件即可。——青柠账本客服 孙婷")], "可以直接发送，或改完再发"), BeCitations([{title: "Stripe 退款记录 re_3Q8…", url: "https://dashboard.stripe.com/test/refunds"}, {title: "故障说明：Stripe webhook 签名校验失败", url: "https://status.qingning-tech.example/incidents/2026-10-30"}])])`),
    user('最近客户问得最多的是哪些'),
    bot(`root = Stack([icon, table])
icon = AgentIcon("source", "最近 7 天 142 张工单")
table = BeTable(["问题", "工单数", "建议回复"], [["导出 CSV 乱码", "38", "下个版本修复；临时用 WPS 打开"], ["Mac 登录页空白", "27", "已修复，请刷新或清缓存"], ["重复扣费", "3", "已退款并补偿一个月"], ["如何开发票", "21", "设置 › 发票模板"]])`),
    user('乱码那个给个统一回复模板'),
    bot('**模板：导出 CSV 中文乱码**\n\n> 您好，感谢反馈！这是 Windows 版 Excel 的编码兼容问题，我们会在下个版本（预计本周五）修复。在此之前，您可以：\n>\n> 1. 用 WPS 或 Numbers 打开；或\n> 2. 在 Excel 中选择「数据 › 从文本/CSV」，编码选 UTF-8。\n\n已存到客服知识库，标签「导出」。'),
  ],
}

/** The group chat: people and bots talking about Friday's release. */
export const GROUP = {
  key: 'g-release',
  title: 'v2.4 发版群',
  bots: ['release', 'frontend', 'backend', 'support'],
  people: ['zhou', 'chen', 'liu'],
  messages: [
    { by: 'zhou', body: '周五 v2.4 Web 先上，iOS 下周。大家同步一下还剩什么' },
    { by: 'bot:release', body: '阻塞两个：Stripe webhook 修复（#216 待评审）、多币种迁移的回滚开关。iOS 冷启动崩溃不影响 Web 发版。' },
    { by: 'chen', body: '#216 今天下午能合，合完我把昨天失败的 186 个事件重放掉' },
    { by: 'me', body: '@前端助手 @客服助手 CSV 乱码那个修复也跟这次一起发，客服那边准备好说明', mentions: ['bot:frontend', 'bot:support'] },
    { by: 'bot:frontend', body: '收到，#485 已在评审，周四前合。' },
    { by: 'bot:support', body: '收到。已准备好回复模板，发版后给 38 位反馈过的客户群发通知。' },
    { by: 'liu', body: '回归用例我周四上午在 staging 跑一遍，结果发群里' },
    { by: 'bot:backend', body: '迁移脚本在生产快照上演练了两次，都在 4 分钟内完成，回滚开关已加。' },
  ],
}
