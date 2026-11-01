// Sample content for scripts/demo-data/seed.mjs: the day-to-day of a small,
// fictional SaaS company. Nothing here names the sample as such; rows are
// found and removed only by their id prefix (shared.mjs, cleanup.mjs).
// Keys are stable: the seed derives row ids from them.

export const WORKSPACE_NAME = '青柠科技'
export const WORKSPACE_SLUG = 'qingning'
export const TEAM = { key: 'team-ledger', name: '青柠账本', identifier: 'QN', description: '' }

/** The other seven people at the company (users with reserved .example emails; nobody can sign in as them). */
export const PEOPLE = [
  { key: 'lin', name: '林晓', role: 'member', email: 'lin.xiao@qingning-tech.example' },
  { key: 'chen', name: '陈予', role: 'member', email: 'chen.yu@qingning-tech.example' },
  { key: 'zhou', name: '周宁', role: 'admin', email: 'zhou.ning@qingning-tech.example' },
  { key: 'wang', name: '王蕾', role: 'member', email: 'wang.lei@qingning-tech.example' },
  { key: 'zhao', name: '赵一鸣', role: 'member', email: 'zhao.yiming@qingning-tech.example' },
  { key: 'sun', name: '孙婷', role: 'member', email: 'sun.ting@qingning-tech.example' },
  { key: 'liu', name: '刘洋', role: 'member', email: 'liu.yang@qingning-tech.example' },
]

/** Bots; color/shape cover the palette in lib/bot-shapes.ts. */
export const BOTS = [
  { key: 'frontend', name: '前端助手', color: 'bleu', shape: 'squircle', model: 'claude', repository: 'qingning-tech/ledger-web' },
  { key: 'backend', name: '后端值班', color: 'orange', shape: 'hexagone', model: 'codex', repository: 'qingning-tech/ledger-api' },
  { key: 'ops', name: '运维值班', color: 'vert', shape: 'galet', model: 'claude', repository: 'qingning-tech/ledger-api' },
  { key: 'data', name: '数据分析', color: 'violet', shape: 'fleur', model: 'mikka', repository: null },
  { key: 'release', name: '发版助手', color: 'rouge', shape: 'etoile', model: 'mikka', repository: 'qingning-tech/ledger-web' },
  { key: 'ios', name: 'iOS 助手', color: 'turquoise', shape: 'chat', model: 'claude', repository: 'qingning-tech/ledger-ios' },
  { key: 'support', name: '客服助手', color: 'ambre', shape: 'nuage', model: 'mikka', repository: null },
]

const pr = (n, state, title, repo = 'qingning-tech/ledger-web') => ({ url: `https://github.com/${repo}/pull/${n}`, state, title })
const API = 'qingning-tech/ledger-api'
const IOS = 'qingning-tech/ledger-ios'
const L = {
  bug: { name: 'Bug', color: 'red' }, regression: { name: '回归', color: 'red' }, web: { name: 'Web', color: 'blue' },
  ios: { name: 'iOS', color: 'blue' }, api: { name: 'API', color: 'violet' }, payments: { name: '支付', color: 'yellow' },
  perf: { name: '性能', color: 'yellow' }, ci: { name: 'CI', color: 'gray' }, security: { name: '安全', color: 'red' },
  customer: { name: '客户反馈', color: 'green' }, release: { name: 'v2.4', color: 'green' }, design: { name: '设计', color: 'blue' },
  db: { name: '数据库', color: 'violet' }, flaky: { name: 'Flaky', color: 'gray' },
}

/**
 * Board tasks. `due` is days from the seed date (negative = overdue).
 * `assignee`: a PEOPLE key, 'me' (the account owner) or 'bot:<key>'.
 */
export const ISSUES = [
  // —— Backlog
  { key: 'i-dark-mode', status: 'backlog', priority: 'low', title: '深色模式下报表页的折线图看不清', labels: [L.design, L.web], assignee: 'wang',
    body: ['深色模式下，「收支趋势」图的网格线和坐标文字几乎和背景同色。', '设计稿里有深色配色，前端还没接。'] },
  { key: 'i-invoice-rounding', status: 'backlog', priority: 'normal', title: '多币种账户导出发票 PDF 时合计金额与明细之和差 0.01，客户对账时发现，需要统一四舍五入的时机', labels: [L.bug, L.payments, L.customer, L.api], assignee: 'bot:backend',
    body: ['客户「禾木咖啡」反馈：发票 PDF 的合计比明细加起来多 0.01 元。', '明细逐行四舍五入，合计用的是未取整的原始值。两边应该在同一步取整。'] },
  { key: 'i-wechat-pay-refund', status: 'backlog', priority: 'low', title: '微信支付部分退款后账单状态显示「已退款」', labels: [L.payments], assignee: null, due: 14,
    body: ['部分退款应显示「部分退款」并保留剩余金额。'] },

  // —— Todo
  { key: 'i-safari-blank', status: 'todo', priority: 'urgent', title: '登录页在 Safari 17 上白屏', labels: [L.bug, L.web, L.regression], assignee: 'lin', due: -1, run: 'failed',
    body: ['从 v2.3.2 开始，macOS Safari 17.x 打开 /login 白屏，控制台报 `SyntaxError: Invalid regular expression: invalid group specifier name`。', 'Chrome、Firefox 正常。怀疑某个依赖用了 lookbehind 正则。'],
    checklist: [['在 BrowserStack 上复现', true], ['定位引入 lookbehind 的依赖', true], ['加 Safari 的 Playwright 冒烟用例', false]] },
  { key: 'i-rate-limit', status: 'todo', priority: 'high', title: '开放平台客户批量导入时被限流到 429', labels: [L.api, L.customer], assignee: 'chen', due: 3,
    body: ['「米粒电商」通过 API 每分钟导入约 300 张订单，全部返回 429。', '当前限流是每个 token 每分钟 60 次，对批量接口太紧。考虑按接口分级，或者提供 /orders:batch。'],
    pullRequests: [pr(214, 'draft', 'feat(api): per-route rate limits', API)] },
  { key: 'i-dependabot', status: 'todo', priority: 'high', title: 'Dependabot：axios 1.6.x 存在 SSRF 漏洞（CVE-2024-39338）', labels: [L.security, L.web], assignee: 'bot:frontend', run: 'waiting',
    body: ['Dependabot 提了升级到 1.7.4 的 PR，但 CI 里有两个接口 mock 测试失败。', '需要确认是 mock 写法的问题还是 axios 行为变了。'] },
  { key: 'i-sentry-spike', status: 'todo', priority: 'normal', title: 'Sentry：`TypeError: Cannot read properties of undefined (reading \'amount\')` 激增', labels: [L.bug, L.web], assignee: 'liu', due: 2,
    body: ['昨晚 21:00 起每小时 200+ 次，集中在「账单详情」页。', '都来自没有任何收支记录的新账户。'] },

  // —— Doing
  { key: 'i-slow-report', status: 'doing', priority: 'high', title: '月度报表接口 P95 8 秒，数据库慢查询', labels: [L.perf, L.db, L.api], assignee: 'bot:ops', run: 'running',
    body: ['/api/reports/monthly 的 P95 从 1.2s 涨到 8s。慢查询日志指向 `transactions` 按 `(account_id, created_at)` 的范围扫描。', '缺复合索引；另外报表每次都全量聚合，可以按月预聚合。'],
    pullRequests: [pr(209, 'merged', 'chore(db): add slow query logging', API), pr(217, 'open', 'perf(db): composite index on transactions', API)] },
  { key: 'i-next-build', status: 'doing', priority: 'normal', title: '升级 Next.js 15 后生产构建从 3 分钟变成 11 分钟', labels: [L.perf, L.ci, L.web], assignee: 'bot:frontend', run: 'running', due: 1,
    body: ['升级后 `next build` 在 CI 上要 11 分钟。', '`--profile` 显示时间花在类型检查和一个超大的 barrel 文件上。'],
    pullRequests: [pr(488, 'open', 'build: drop barrel imports in components/ui')] },
  { key: 'i-ios-crash', status: 'doing', priority: 'urgent', title: 'iOS 2.4.0 在 iOS 16 冷启动崩溃', labels: [L.ios, L.bug, L.regression], assignee: 'bot:ios', run: 'waiting', due: -2,
    body: ['TestFlight 2.4.0 (312) 在 iOS 16.7 上冷启动直接闪退，Crashlytics 显示 `EXC_BAD_ACCESS` 在 Keychain 读取。', 'iOS 17 正常。'] },
  { key: 'i-flaky-e2e', status: 'doing', priority: 'normal', title: 'CI 上「创建发票」e2e 用例偶发失败', labels: [L.ci, L.flaky], assignee: 'me',
    body: ['最近 30 次 main 构建失败 5 次，都是 invoice-create.spec.ts 等待「保存成功」toast 超时。'],
    checklist: [['本地 --repeat-each 50 复现', true], ['去掉测试里的 waitForTimeout(500)', false], ['toast 改为等接口返回', false]] },
  { key: 'i-release-parent', status: 'doing', priority: 'high', title: 'v2.4 发版准备', labels: [L.release], assignee: 'zhou', due: 4,
    body: ['v2.4 计划周五上线：多币种账户、发票模板、iOS 小组件。'] },

  // —— Review
  { key: 'i-csv-garbled', status: 'review', priority: 'normal', title: '导出 CSV 用 Excel 打开中文乱码', labels: [L.bug, L.customer, L.web], assignee: 'bot:frontend', run: 'succeeded',
    body: ['Windows Excel 打开导出的账单 CSV，中文全是乱码。Numbers 和 WPS 正常。', '需要在文件开头加 UTF-8 BOM。'],
    pullRequests: [pr(485, 'open', 'fix(export): prepend UTF-8 BOM for Excel')] },
  { key: 'i-stripe-webhook', status: 'review', priority: 'high', title: 'Stripe webhook 签名校验失败，订阅续费没有入账', labels: [L.payments, L.api, L.bug], assignee: 'chen', due: 0,
    body: ['昨天起 `invoice.paid` 事件全部 400：`No signatures found matching the expected signature for payload`。', '原因：网关升级后把 body 解析成 JSON 再传进来，签名校验需要原始 body。'],
    pullRequests: [pr(216, 'open', 'fix(stripe): verify webhook against raw body', API), pr(218, 'draft', 'chore: replay failed invoice.paid events', API)] },
  { key: 'i-widget', status: 'review', priority: 'normal', title: 'iOS 桌面小组件：今日收支', labels: [L.ios, L.release], assignee: 'zhao',
    body: ['小、中两种尺寸，数据每 30 分钟刷新一次。'],
    pullRequests: [pr(97, 'open', 'feat(widget): today summary widget', IOS), pr(95, 'merged', 'chore: app group for widget data', IOS), pr(93, 'closed', 'wip: widget prototype', IOS)] },

  // —— Done
  { key: 'i-lcp', status: 'done', priority: 'normal', title: '首页 LCP 从 3.4s 优化到 1.6s', labels: [L.perf, L.web], assignee: 'bot:frontend', run: 'succeeded',
    body: ['首屏大图改为 AVIF + 预加载，字体子集化。'], pullRequests: [pr(471, 'merged', 'perf(home): preload hero image, subset fonts')] },
  { key: 'i-alipay-retry', status: 'done', priority: 'high', title: '支付宝异步通知超时后没有重试', labels: [L.payments, L.api], assignee: 'bot:backend', run: 'succeeded',
    body: ['通知处理超过 5 秒会被支付宝判定失败；改为先落库再异步处理。'], pullRequests: [pr(205, 'merged', 'fix(alipay): ack notify before processing', API)] },
  { key: 'i-privacy-link', status: 'done', priority: 'low', title: '注册页隐私政策链接 404', labels: [L.web], assignee: 'wang',
    body: ['官网改版后链接变了。'], pullRequests: [pr(479, 'merged', 'fix: privacy policy link')] },
  { key: 'i-sub-notes', status: 'done', priority: 'normal', title: '写 v2.4 发版说明', labels: [L.release], assignee: 'bot:release', parent: 'i-release-parent', body: ['面向客户的版本说明，中英文各一份。'] },
  { key: 'i-sub-migration', status: 'done', priority: 'high', title: '多币种账户的数据迁移演练', labels: [L.release, L.db], assignee: 'chen', parent: 'i-release-parent', body: ['在 staging 上用生产快照演练两次，均在 4 分钟内完成。'] },
  { key: 'i-sub-regression', status: 'todo', priority: 'high', title: 'v2.4 回归测试', labels: [L.release], assignee: 'liu', parent: 'i-release-parent', body: ['Web、iOS 各跑一遍核心流程。'] },

  // —— Canceled / duplicate
  { key: 'i-miniprogram', status: 'canceled', priority: 'low', title: '微信小程序版本', labels: [], assignee: null, body: ['Q4 不做，先把 iOS 和 Web 打磨好。'] },
  { key: 'i-safari-dup', status: 'duplicate', priority: 'normal', title: 'Mac 上打开登录页一片空白', labels: [L.bug], assignee: null, duplicateOf: 'i-safari-blank', body: ['客户来信，与「登录页在 Safari 17 上白屏」相同。'] },
]

/** Personal tasks (lock on the card). They show on every board of the owner, so keep this short. */
export const PERSONAL_ISSUES = [
  { key: 'p-okr', status: 'todo', priority: 'normal', title: '写 Q4 技术 OKR 复盘', labels: [], assignee: 'me', due: 5,
    body: ['稳定性（P1 事故数、Sentry 错误率）、交付（发版频率）、成本（云账单）。'] },
]

/** Computers in Settings › 设备. All disabled with no token, so nothing is ever dispatched to them. */
export const DEVICES = [
  // `online` keeps lastSeenAt ahead of now so the row reads online.
  { key: 'd-mbp', name: 'Alex 的 MacBook Pro', hostname: 'alex-mbp.local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', online: true, autoSchedule: false,
    harnesses: [{ harness: 'claude_code', installed: true, version: '2.4.1' }, { harness: 'codex', installed: true, version: '0.61.0' }] },
  { key: 'd-staging', name: 'staging-server', hostname: 'staging-01', deviceType: 'server', platform: 'linux', arch: 'x64', lastSeenMinutes: 42, autoSchedule: true,
    harnesses: [{ harness: 'codex', installed: true, version: '0.61.0' }] },
  { key: 'd-mini', name: 'Mac mini（iOS 构建）', hostname: 'build-mini.local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', lastSeenMinutes: 60 * 24 * 9, autoSchedule: null,
    harnesses: [{ harness: 'claude_code', installed: true, version: '2.1.0' }] },
]

/** Coding agents the threads run on. */
export const AGENTS = [
  { key: 'ag-claude', name: 'Claude Code · MacBook', harness: 'claude_code', device: 'd-mbp' },
  { key: 'ag-codex', name: 'Codex · staging', harness: 'codex', device: 'd-staging' },
]

const text = (delta, id = 't1') => ({ type: 'text-delta', id, delta })
const tool = id => ({ type: 'tool-input-available', toolCallId: id })

/**
 * Threads. `minutesAgo` is when it started; finished ones also have `minutes`.
 * Running/waiting threads carry no lease, so run recovery never reclaims them.
 */
export const RUNS = [
  { key: 'r-slow-report', issue: 'i-slow-report', bot: 'ops', agent: 'ag-codex', status: 'running', minutesAgo: 30,
    prompt: '月度报表接口 P95 8 秒\n先用 EXPLAIN ANALYZE 定位，再加索引；在 staging 上对比。',
    lastReply: '索引已在 staging 建好，P95 从 8.1s 降到 0.9s，正在跑回归测试。',
    chunks: [text('EXPLAIN ANALYZE：Seq Scan on transactions，rows=2.1M，耗时 7.6s。'), tool('a'), tool('b'), text('新建 (account_id, created_at) 复合索引，分支 perf/transactions-index。', 't2'), tool('c'), text('索引已在 staging 建好，P95 从 8.1s 降到 0.9s，正在跑回归测试。', 't3')] },
  { key: 'r-next-build', issue: 'i-next-build', bot: 'frontend', agent: 'ag-claude', status: 'running', minutesAgo: 45,
    prompt: '升级 Next.js 15 后构建变慢\n先用 --profile 找出耗时，再改。',
    lastReply: '去掉 components/ui 的 barrel 导入后本地构建 4 分 10 秒，CI 在跑。',
    chunks: [text('next build --profile：类型检查 4 分钟，components/ui/index.ts 被 300+ 文件引用。'), tool('a'), tool('b'), text('改成按文件导入，提交 build: drop barrel imports (a3f9c21)。', 't2'), tool('c'), text('去掉 components/ui 的 barrel 导入后本地构建 4 分 10 秒，CI 在跑。', 't3')] },
  { key: 'r-dependabot', issue: 'i-dependabot', bot: 'frontend', agent: 'ag-claude', status: 'waiting_input', minutesAgo: 90,
    prompt: '处理 Dependabot 的 axios 1.7.4 升级 PR，修好失败的测试',
    lastReply: '两个失败都是 mock 依赖了 axios 内部的 adapter 字段。改用 msw 还是只改这两个测试？',
    chunks: [text('CI 失败：api/client.test.ts 两个用例，都直接替换了 axios.defaults.adapter。'), tool('a'), tool('b'), text('两个失败都是 mock 依赖了 axios 内部的 adapter 字段。改用 msw 还是只改这两个测试？', 't2')] },
  { key: 'r-ios-crash', issue: 'i-ios-crash', bot: 'ios', agent: 'ag-claude', status: 'waiting_input', minutesAgo: 150,
    prompt: 'iOS 16 冷启动崩溃\n先在模拟器复现，再看 Crashlytics 堆栈。',
    lastReply: '原因是在 App 启动前访问了 kSecAttrAccessibleAfterFirstUnlock 的 Keychain 项。要把读取挪到 didFinishLaunching 之后吗？',
    chunks: [text('iOS 16.4 模拟器冷启动 10 次，崩溃 10 次。'), { type: 'data-computer', data: { runId: '{{run:r-ios-crash}}', botId: '{{bot:ios}}', task: '在 iOS 16.4 模拟器上冷启动 10 次，抓崩溃日志' } }, tool('a'), text('原因是在 App 启动前访问了 kSecAttrAccessibleAfterFirstUnlock 的 Keychain 项。要把读取挪到 didFinishLaunching 之后吗？', 't2')] },
  { key: 'r-safari', issue: 'i-safari-blank', bot: 'frontend', agent: 'ag-codex', status: 'failed', minutesAgo: 60 * 5, minutes: 14,
    prompt: '复现 Safari 17 登录页白屏，写一个失败的 Playwright 用例',
    lastReply: 'Playwright WebKit 浏览器下载失败，没能跑到用例。',
    error: 'browserType.launch: Executable doesn\'t exist at /home/runner/.cache/ms-playwright/webkit-2104/pw_run.sh',
    chunks: [text('安装 Playwright WebKit。'), tool('a'), { type: 'error', errorText: 'browserType.launch: Executable doesn\'t exist at /home/runner/.cache/ms-playwright/webkit-2104/pw_run.sh' }] },
  { key: 'r-csv', issue: 'i-csv-garbled', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 20, minutes: 22,
    prompt: '导出的 CSV 在 Excel 里中文乱码', lastReply: 'PR #485 已提交：在文件开头写入 UTF-8 BOM，补了单测。',
    chunks: [text('Excel 默认按系统代码页解析没有 BOM 的 CSV。'), tool('a'), tool('b'), text('PR #485 已提交：在文件开头写入 UTF-8 BOM，补了单测。', 't2')] },
  { key: 'r-lcp', issue: 'i-lcp', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 50, minutes: 37,
    prompt: '首页 LCP 优化到 2 秒以内', lastReply: '已合并 #471，Lighthouse LCP 1.6s。',
    chunks: [text('LCP 元素是首屏大图（1.2MB JPEG）。'), tool('a'), text('已合并 #471，Lighthouse LCP 1.6s。', 't2')], artifacts: ['a-lcp-compare'] },
  { key: 'r-alipay', issue: 'i-alipay-retry', bot: 'backend', agent: 'ag-codex', status: 'succeeded', minutesAgo: 60 * 70, minutes: 41,
    prompt: '支付宝异步通知超时后没有重试', lastReply: '已合并 #205：先 ack 再异步处理，加了幂等键。',
    chunks: [text('通知处理里同步调用了发票服务，平均 6.2 秒。'), tool('a'), tool('b'), text('已合并 #205：先 ack 再异步处理，加了幂等键。', 't2')] },
  { key: 'r-safari-analysis', issue: 'i-safari-blank', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 8, minutes: 26,
    prompt: '分析 Safari 17 白屏的根因，写成文档', lastReply: '根因分析已提交为 Artifact。',
    chunks: [text('二分 v2.3.1..v2.3.2 的依赖变更：date-fns-tz 3.1 引入了 lookbehind。'), tool('a'), text('根因分析已提交为 Artifact。', 't2')], artifacts: ['a-safari-rca'] },
  { key: 'r-release-notes', issue: 'i-sub-notes', bot: 'release', agent: 'ag-codex', status: 'succeeded', minutesAgo: 60 * 3, minutes: 6,
    prompt: '起草 v2.4 发版说明', lastReply: '草稿已提交为 Artifact。',
    chunks: [text('汇总 v2.3.2 以来合入的 23 个 PR。'), tool('a'), text('草稿已提交为 Artifact。', 't2')], artifacts: ['a-release-notes'] },
  { key: 'r-rate-limit-cancel', issue: 'i-rate-limit', bot: 'backend', agent: 'ag-codex', status: 'cancelled', minutesAgo: 60 * 26, minutes: 3,
    prompt: '复现开放平台 429', lastReply: '已停止：改用压测脚本在 staging 复现。', chunks: [text('已停止。')] },
]

/** Artifacts the threads handed over; content is stored inline. */
export const ARTIFACTS = [
  { key: 'a-release-notes', kind: 'markdown', title: 'v2.4 发版说明', author: '发版助手', versions: [
    '# 青柠账本 v2.4\n\n## 新功能\n\n- 多币种账户\n- 发票模板\n',
    '# 青柠账本 v2.4\n\n## 新功能\n\n- **多币种账户**：一个账本里同时记人民币、美元、港币，报表自动按当日汇率折算。\n- **发票模板**：自定义抬头、Logo 和备注，导出 PDF。\n- **iOS 桌面小组件**：不用打开 App 就能看今日收支。\n\n## 修复\n\n- 导出 CSV 在 Excel 中打开不再乱码\n- 支付宝付款后账单状态偶尔不更新\n- 首页加载速度提升约一倍\n\n## 已知问题\n\n- 多币种账户暂不支持导入银行流水\n',
  ] },
  { key: 'a-safari-rca', kind: 'markdown', title: 'Safari 白屏根因分析', author: '前端助手', versions: [
    '# 登录页在 Safari 17 白屏：根因分析\n\n## 影响\n\n2026-10-28 发布 v2.3.2 后，macOS Safari 17.0–17.3 用户打开登录页白屏，约占 Web 登录量的 6%。\n\n## 根因\n\n`date-fns-tz` 从 3.0 升到 3.1，新增的时区解析用了命名捕获组加 lookbehind：\n\n```js\n/(?<=GMT)(?<sign>[+-])(?<hours>\\d{2})/\n```\n\nSafari 17.4 之前不支持 lookbehind，整个 bundle 解析失败。\n\n## 修复\n\n1. 锁定 `date-fns-tz@3.0.1`（已发 v2.3.3）\n2. CI 增加 WebKit 冒烟用例\n3. 构建时用 `browserslist` 检查语法兼容性\n\n## 时间线\n\n| 时间 | 事件 |\n|---|---|\n| 10-28 18:02 | v2.3.2 发布 |\n| 10-28 21:40 | 第一封客户邮件 |\n| 10-29 10:15 | 定位到依赖 |\n| 10-29 11:30 | v2.3.3 发布 |\n',
  ] },
  { key: 'a-lcp-compare', kind: 'html', title: '首页 LCP 优化前后对比', author: '前端助手', versions: [
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>首页 LCP 优化前后对比</title><style>body{font:14px system-ui;margin:24px;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 12px;text-align:right}th:first-child,td:first-child{text-align:left}</style><h1>首页 LCP 优化前后对比</h1><table><tr><th>指标</th><th>优化前</th><th>优化后</th></tr><tr><td>LCP</td><td>3.4s</td><td>1.6s</td></tr><tr><td>首屏图片</td><td>1.2MB JPEG</td><td>180KB AVIF</td></tr><tr><td>字体</td><td>4.1MB</td><td>320KB（子集）</td></tr><tr><td>Lighthouse 性能分</td><td>62</td><td>94</td></tr></table></html>',
  ] },
]

/** Profile facts for the 记忆 page; personal by design, so only a few. */
export const FACTS = [
  { key: 'f-small-prs', kind: 'preference', subject: '喜欢小而单一的 PR', value: { note: '一个 PR 只改一件事，数据库迁移单独提' }, confidence: 0.86 },
  { key: 'f-pnpm', kind: 'tool', subject: 'pnpm', value: { version: '9' }, confidence: 0.92 },
  { key: 'f-review-time', kind: 'routine', subject: '上午集中 review PR', value: { window: '09:30–11:00' }, confidence: 0.7 },
  { key: 'f-release', kind: 'deadline', subject: 'v2.4 周五上线', value: { date: 'friday' }, confidence: 0.8 },
]

/** 建议 rows, dated more than a day back so the 08:00 briefing never picks them up. */
export const SUGGESTIONS = [
  { key: 's-review', source: 'github', action: 'review', title: 'fix(stripe): verify webhook against raw body', actionTitle: '评审陈予的 PR：Stripe webhook 签名校验', actor: '陈予', level: 'high', required: true, hoursAgo: 26, url: 'https://github.com/qingning-tech/ledger-api/pull/216' },
  { key: 's-linear', source: 'linear', action: 'handle', title: 'iOS 2.4.0 在 iOS 16 冷启动崩溃', actionTitle: '处理分配给你的问题：iOS 16 冷启动崩溃', actor: '赵一鸣', level: 'critical', required: true, hoursAgo: 28, url: null },
  { key: 's-slack', source: 'slack', action: 'reply', title: 'v2.4 周五能上吗？市场那边周六要发公众号', actionTitle: '回复周宁：v2.4 能否周五上线', actor: '周宁', level: 'ask', required: false, hoursAgo: 31, url: null },
  { key: 's-gmail', source: 'gmail', action: 'reply', title: '【投诉】这个月被扣了两次会员费', actionTitle: '回复客户禾木咖啡：重复扣费投诉', actor: '禾木咖啡 张老板', level: 'high', required: false, hoursAgo: 40, url: null },
  { key: 's-notion', source: 'notion', action: 'read', title: 'Q4 产品路线图有 3 条新评论', actionTitle: '看 Q4 路线图的新评论', actor: '王蕾', level: 'normal', required: false, hoursAgo: 75, url: null },
]

/** What each bot remembers (coordinator_sessions.memory, Markdown lines). */
export const BOT_MEMORY = {
  frontend: '- 必须兼容 Safari 16 及以上。\n- 组件按文件导入，不用 barrel。',
  backend: '- 支付回调先落库再处理，全部带幂等键。\n- 数据库迁移单独提 PR。',
  ops: '- 生产变更只在工作日 10:00–17:00。',
  release: '- 发版前一天冻结 main。\n- iOS 灰度首日 20%。',
}

/**
 * More threads per bot, so each bot shows the parallel work it runs: several
 * at once, some waiting on a person, the rest finished. Not tied to board
 * tasks, so the cards keep their run states; a thread is named by its first
 * prompt line. [title, status, hoursAgo, lastReply]
 */
const R = 'running', W = 'waiting_input', S = 'succeeded', F = 'failed', C = 'cancelled'
export const BOT_THREADS = {
  frontend: [
    ['给账单列表加虚拟滚动', R, 0.6, '用 @tanstack/react-virtual 改完了列表，正在测 5000 行的滚动帧率。'],
    ['设置页表单迁移到 react-hook-form', R, 1.2, '已迁移 6 个表单中的 4 个，校验规则保持不变。'],
    ['深色模式：报表图表配色', R, 2.1, '折线和网格线换成设计稿的深色 token，正在截图对比。'],
    ['登录页加 Safari WebKit 冒烟用例', W, 3, 'CI 镜像里没有 WebKit 依赖。要改用 playwright 官方镜像吗？'],
    ['发票预览页 a11y 检查', S, 9, 'axe 检查 0 个严重问题，修了 3 个缺 label 的输入框（#486）。'],
    ['把 moment 换成 date-fns', S, 20, '包体积减少 61KB，所有日期格式化快照一致（#482）。'],
    ['修复移动端底部导航被键盘顶起', S, 28, 'iOS Safari 上改用 visualViewport 监听，已合并 #480。'],
    ['Storybook 升级到 8.4', S, 44, '升级完成，修了 2 个 addon 的配置，视觉回归 0 差异。'],
    ['账单详情页空状态', S, 52, '新账户没有记录时显示引导卡片，已提 #487。'],
    ['ESLint 迁移到 flat config', F, 70, 'eslint-plugin-import 还不支持 flat config，构建失败。'],
    ['重做首页定价卡片', C, 96, '设计稿还在改，先停了。'],
  ],
  backend: [
    ['开放平台按路由分级限流', R, 0.8, '令牌桶改成按路由配置，批量接口 600 次/分钟，正在写集成测试。'],
    ['重放 186 个失败的 invoice.paid 事件', R, 1.5, '已重放 112/186，全部入账成功，没有重复扣款。'],
    ['发票 PDF 金额统一取整', R, 2.6, '明细和合计改为同一步四舍五入，正在对比 1000 张历史发票。'],
    ['微信支付部分退款状态', W, 4, '退款回调里没有剩余金额字段，要调用查询接口补吗？会多一次请求。'],
    ['给 /v1/orders 加幂等键', S, 11, '支持 Idempotency-Key 头，24 小时内重复请求返回首次结果（#215）。'],
    ['升级 Node 18 到 22', S, 22, '全部测试通过，冷启动快了约 15%（#212）。'],
    ['审计日志接口分页', S, 30, '改为游标分页，大账户查询从 4s 降到 120ms（#211）。'],
    ['清理过期的 API token', S, 47, '删掉 1,284 个 180 天未使用的 token，已通知相关客户。'],
    ['修复时区导致的日报少一天', S, 60, '统一用账户时区计算日界，补了跨时区测试（#210）。'],
    ['导出接口改为异步任务', F, 75, '队列 worker 在 staging 上内存超限被杀，需要先分批读。'],
    ['GraphQL 网关调研', C, 120, '优先级下调，先停。'],
  ],
  ops: [
    ['生产库加 transactions 复合索引', R, 0.5, '等 22:00 窗口，已在 staging 验证 CONCURRENTLY 不锁写。'],
    ['Sentry 告警规则整理', R, 1.4, '把 46 条告警合并成 12 条，按服务和严重程度分组。'],
    ['日志保留期从 90 天改为 30 天', W, 3.5, '每月能省约 ¥1,800，但会影响审计导出。要先确认合规要求吗？'],
    ['Redis 内存告警', S, 8, 'session key 没设过期时间，补上 TTL 后内存从 92% 降到 41%。'],
    ['CDN 缓存命中率偏低', S, 18, '静态资源加了 content hash，命中率从 71% 升到 96%。'],
    ['数据库每日备份恢复演练', S, 26, '从昨天的快照恢复到新实例用时 11 分钟，校验通过。'],
    ['升级 Postgres 15 到 16', S, 50, '在 staging 演练两次，停机 3 分钟以内，定在下周六凌晨。'],
    ['证书自动续期失败', S, 66, 'DNS 验证的 API token 过期了，已更新并加了到期提醒。'],
    ['staging 磁盘满', S, 80, '清理旧的 Docker 镜像，释放 38GB，加了每周清理任务。'],
    ['k8s 节点池扩容', F, 90, '云厂商当前可用区 4C8G 库存不足，扩容失败。'],
    ['接入 OpenTelemetry', C, 110, '先做 Sentry 性能监控，这个延后。'],
  ],
  data: [
    ['10 月经营周报', R, 0.7, '收入、转化、留存三部分已完成，正在写结论。'],
    ['试用转付费漏斗拆解', R, 1.8, '按注册渠道拆分漏斗，搜索广告的转化最低（6.1%）。'],
    ['流失客户访谈名单', W, 2.5, '筛出 40 家近 30 天流失的付费客户，要按 MRR 排序还是按使用时长？'],
    ['定价页 A/B 测试结果', S, 10, 'B 版本（年付默认选中）转化 +1.8 个点，p=0.03。'],
    ['发票功能使用情况', S, 21, '开过发票的客户 90 天留存高 14 个点。'],
    ['渠道 ROI 月报', S, 33, '内容营销 ROI 最高（4.2），信息流广告最低（0.8）。'],
    ['NPS 调查结果整理', S, 46, 'NPS 41，主要抱怨是导出慢和 Mac 登录问题。'],
    ['埋点数据核对', S, 58, '「开发票」事件在 iOS 端重复上报，已提给 iOS 助手。'],
    ['客户分层模型', S, 72, '按月流水和活跃度分成 5 层，结果同步到 CRM。'],
    ['同比数据补齐', F, 85, '去年 3 月的原始数据缺失，无法计算同比。'],
    ['竞品价格调研', C, 100, '市场部已经做过，取消。'],
  ],
  release: [
    ['v2.4.0-rc.1 构建', R, 0.9, 'Web 构建完成，正在跑 staging 冒烟测试（42/60）。'],
    ['整理 v2.4 变更清单', R, 1.6, '从 23 个 PR 里整理出用户可见的 9 项改动。'],
    ['App Store 审核材料', W, 3.2, '小组件截图需要新的营销文案，用哪一版？'],
    ['v2.3.3 热修发布', S, 30, '锁定 date-fns-tz@3.0.1，发布后 Safari 白屏工单归零。'],
    ['v2.3.2 发布', S, 98, 'Web 和 iOS 同步上线，Sentry 错误率无明显变化。'],
    ['发版检查清单模板', S, 120, '把迁移演练、回滚开关、客服通知加进模板。'],
    ['changelog 页面自动生成', S, 140, '从合并的 PR 标签生成，已上线到官网。'],
    ['v2.3.1 发布', S, 170, '修复 3 个支付相关问题，灰度 24 小时后全量。'],
    ['iOS 2.3.3 提审', S, 190, '审核 18 小时通过。'],
    ['v2.3.2 Android 包签名', F, 100, '签名证书密码在 CI 里过期，构建失败。'],
    ['v2.3.0 补丁合并', C, 210, '已包含在 v2.3.1，取消。'],
  ],
  ios: [
    ['iOS 16 冷启动崩溃回归测试', R, 0.6, '在 4 台设备上各冷启动 20 次，目前 0 崩溃。'],
    ['小组件数据刷新策略', R, 1.3, '改用 Timeline 每 30 分钟刷新，耗电测试进行中。'],
    ['记账页键盘遮挡', R, 2.4, '给金额输入框加了 safeAreaInset，正在 iPhone SE 上验证。'],
    ['Face ID 登录', W, 3.8, '首次开启时要不要强制二次确认密码？'],
    ['Crashlytics 符号表上传', S, 12, 'CI 里自动上传 dSYM，崩溃堆栈能看到行号了。'],
    ['深色模式图标', S, 24, '补齐 18 个深色图标，已提 #96。'],
    ['iPad 分栏布局', S, 36, '账单列表和详情左右分栏，已合并 #94。'],
    ['推送权限引导', S, 54, '首次记账后再请求权限，授权率从 38% 到 61%。'],
    ['升级到 Xcode 16', S, 68, '修了 12 个新警告，构建时间不变。'],
    ['TestFlight 自动分发', F, 82, 'App Store Connect API key 权限不足。'],
    ['watchOS 版本调研', C, 130, '暂不做。'],
  ],
  support: [
    ['回复禾木咖啡重复扣费投诉', R, 0.4, '退款单已提交，正在起草邮件。'],
    ['整理本周高频问题', R, 1.1, '142 张工单已分类，CSV 乱码 38 张居首。'],
    ['米粒电商 API 限流沟通', W, 2.2, '对方问能否临时提高额度到 300 次/分钟，要答应吗？'],
    ['CSV 乱码统一回复模板', S, 6, '模板已存入知识库，标签「导出」。'],
    ['Safari 白屏客户批量通知', S, 27, '给 27 位反馈的客户发了修复通知，19 位已回复确认。'],
    ['知识库：如何开发票', S, 40, '新增图文教程，相关工单下降 30%。'],
    ['退款流程梳理', S, 56, '把审批从 3 步减到 2 步，平均处理时间 2 天降到 4 小时。'],
    ['客服满意度周报', S, 74, '满意度 94%，差评主要是响应慢。'],
    ['工单标签整理', S, 92, '合并重复标签，从 63 个减到 24 个。'],
    ['同步工单到 Linear', F, 66, 'Linear API 返回 401，需要重新授权。'],
    ['夜间自动回复', C, 115, '先用人工值班。'],
  ],
}
