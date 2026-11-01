// Demo content for scripts/demo-data/seed.mjs. Everything here is invented but
// written the way this team actually files work: a symptom, how to reproduce
// it, what was ruled out. Keys are stable: the seed derives row ids from them,
// so editing text and re-running updates rows instead of duplicating them.

export const WORKSPACE_NAME = '演示数据（可删除）'
export const WORKSPACE_SLUG = 'demo-data-removable'
export const TEAM = { key: 'team-app', name: '应用', identifier: 'APP', description: '' }

/** Teammates who exist only in the demo workspace (users with .invalid emails, no sign-in). */
export const PEOPLE = [
  { key: 'lin', name: '林晓', role: 'member' },
  { key: 'chen', name: '陈予', role: 'member' },
  { key: 'zhou', name: '周宁', role: 'admin' },
]

/** Bots of the demo workspace; color/shape cover the palette in lib/bot-shapes.ts. */
export const BOTS = [
  { key: 'frontend', name: 'Mikka Frontend', color: 'bleu', shape: 'squircle', model: 'claude', repository: 'mikka-demo/web' },
  { key: 'backend', name: '后端值班', color: 'orange', shape: 'hexagone', model: 'codex', repository: 'mikka-demo/web' },
  { key: 'daemon', name: 'Daemon 排障', color: 'vert', shape: 'galet', model: 'claude', repository: 'mikka-demo/daemon' },
  { key: 'qa', name: 'QA 巡检', color: 'violet', shape: 'fleur', model: 'mikka', repository: null },
  { key: 'release', name: '发布经理', color: 'rouge', shape: 'etoile', model: 'mikka', repository: 'mikka-demo/web' },
  { key: 'mobile', name: 'iOS 客户端', color: 'turquoise', shape: 'chat', model: 'claude', repository: 'mikka-demo/mobile' },
  { key: 'docs', name: '设计规范', color: 'ambre', shape: 'nuage', model: 'mikka', repository: null },
]

const pr = (n, state, title, repo = 'mikka-demo/web') => ({ url: `https://github.com/${repo}/pull/${n}`, state, title })
const L = {
  bug: { name: 'Bug', color: 'red' }, regression: { name: '回归', color: 'red' }, desktop: { name: '桌面端', color: 'blue' },
  mobile: { name: 'iOS', color: 'blue' }, daemon: { name: 'Daemon', color: 'violet' }, ci: { name: 'CI', color: 'gray' },
  board: { name: '看板', color: 'green' }, chat: { name: '聊天', color: 'green' }, auth: { name: '登录', color: 'yellow' },
  perf: { name: '性能', color: 'yellow' }, db: { name: '迁移', color: 'violet' }, billing: { name: '计费', color: 'yellow' },
  design: { name: '设计', color: 'blue' }, flaky: { name: 'Flaky', color: 'gray' },
}

/**
 * Board tasks. `due` is days from the seed date (negative = overdue).
 * `assignee`: a PEOPLE key, 'me' (the account owner) or 'bot:<key>'.
 * `run`: the latest thread's state, which the card shows as a pill.
 */
export const ISSUES = [
  // —— Backlog
  { key: 'i-offline-banner', status: 'backlog', priority: 'low', title: '断网恢复后离线横幅偶尔不消失', labels: [L.bug, L.desktop], assignee: null,
    body: ['Wi-Fi 断开 30 秒再连上，大约五次里有一次顶部「已离线」横幅一直留着，手动刷新才消失。', '怀疑 online 事件比第一次心跳成功早到，状态被旧的失败结果覆盖。'] },
  { key: 'i-search-pinyin', status: 'backlog', priority: 'normal', title: '⌘K 搜索支持拼音首字母匹配任务标题', labels: [L.design], assignee: 'chen',
    body: ['输入「kbl」希望能找到「看板列宽」。现在只做子串匹配。', '先看 Linear 的做法，别引入太重的分词库。'] },
  { key: 'i-export-csv', status: 'backlog', priority: 'low', title: '导出工作区审计日志为 CSV 时时区写成了 UTC', labels: [L.bug], assignee: null, due: 12,
    body: ['设置 › 审计日志 › 导出，时间列全是 UTC，但页面上显示的是本地时间。', '至少在表头写明时区，或者按用户时区导出。'] },
  { key: 'i-long-title', status: 'backlog', priority: 'normal', title: '群聊里同时 @ 三个以上 Bot 时，路由只把消息交给第一个 Bot，其余 Bot 既不回复也不显示「未处理」，用户以为它们都在忙', labels: [L.chat, L.bug, L.regression, L.design], assignee: 'bot:backend',
    body: ['复现：建一个有 4 个 Bot 的群，发「@A @B @C 各自看一下昨天的报错」。只有 A 回复。', 'group_turns 里只有一条记录。预期每个被提及的 Bot 各一条，或者明确提示只会交给一个。'] },

  // —— Todo
  { key: 'i-signin-loop', status: 'todo', priority: 'urgent', title: '桌面端拒绝 handoff 后登录页进入死循环', labels: [L.auth, L.desktop, L.regression], assignee: 'lin', due: -2, run: 'failed',
    body: ['在浏览器授权页点「拒绝」，桌面端回到登录页后立刻又打开浏览器，循环不止。', '影响所有 0.9.x 桌面版。必须在下一个桌面版本前修掉。'],
    checklist: [['复现并录屏', true], ['定位 handoff 拒绝分支', true], ['补 e2e：拒绝后停在登录页', false]] },
  { key: 'i-migration-order', status: 'todo', priority: 'high', title: '并行 PR 的迁移文件时间戳排在 main 之前，部署时被跳过', labels: [L.db, L.ci, L.bug], assignee: 'zhou', due: 3,
    body: ['两个 PR 都基于旧 main 生成了迁移，合并后后合的那个时间戳更早，migrate 认为已经执行过。', 'check:migrations 应该在 PR 上就拒绝早于 main 最新迁移的文件。'],
    pullRequests: [pr(812, 'draft', 'ci: reject migrations older than main')] },
  { key: 'i-unread-dot', status: 'todo', priority: 'normal', title: 'Bot 列表的未读红点在切换工作区后残留', labels: [L.chat, L.bug], assignee: 'bot:frontend', run: 'waiting',
    body: ['在 A 工作区有未读，切到 B 工作区后 B 的某个 Bot 也显示红点，点进去没有新消息。', 'conversation_reads 的 key 没带 workspace？先确认。'] },
  { key: 'i-e2b-quota', status: 'todo', priority: 'normal', title: 'E2B 额度用完时线程卡在「准备中」不报错', labels: [L.bug, L.billing], assignee: 'chen', due: 6,
    body: ['E2B 返回 429 后我们一直重试，线程永远停在准备中。', '期望：第二次失败就结束线程，给出「去设置 › 密钥与环境 换 Key」的卡片。'] },

  // —— Doing
  { key: 'i-flaky-daemon', status: 'doing', priority: 'high', title: 'Daemon 测试在 CI 上偶发超时（sandbox verify 竞态）', labels: [L.daemon, L.ci, L.flaky], assignee: 'bot:daemon', run: 'running',
    body: ['最近 20 次 main 构建失败 4 次，全是 daemon/sandbox.verify.test.ts 超时。', '本地加 --repeat 50 能稳定复现：verify 在 git config 写完之前就读了。'],
    pullRequests: [pr(57, 'merged', 'test: isolate git config per sandbox', 'mikka-demo/daemon'), pr(61, 'open', 'fix: await git config before verify', 'mikka-demo/daemon')] },
  { key: 'i-board-scroll', status: 'doing', priority: 'normal', title: '看板 1280 宽度下横向滚动条盖住最后一张卡', labels: [L.board, L.design], assignee: 'bot:frontend', run: 'running', due: 1,
    body: ['13 寸笔记本、侧栏展开时，「已完成」列底部的卡片被滚动条挡住一半。', '列内容区底部留出滚动条高度即可，别改列宽（R-25 固定 300px）。'],
    pullRequests: [pr(845, 'open', 'fix(board): keep the last card above the scrollbar')] },
  { key: 'i-idle-cpu', status: 'doing', priority: 'high', title: '空闲时标签页 CPU 占用 8%，轮询没有在后台暂停', labels: [L.perf, L.chat], assignee: 'me', due: -1,
    body: ['Chrome 任务管理器里 Mikka 标签页常驻 6–8% CPU。', 'Performance 面板：线程列表每 2 秒轮询一次，页面隐藏时也在跑。'],
    checklist: [['线程列表改为可见时轮询', true], ['未读轮询合并进同一个计时器', false], ['加性能用例防回归', false]] },
  { key: 'i-testflight', status: 'doing', priority: 'normal', title: 'TestFlight 包冷启动白屏 2 秒', labels: [L.mobile, L.perf], assignee: 'bot:mobile', run: 'waiting',
    body: ['iPhone 13、iOS 26.1，冷启动先白屏约 2 秒才出 Bot 列表。', '启动时同步读了整个 SecureStore，改成先渲染缓存再补。'] },
  { key: 'i-subtask-parent', status: 'doing', priority: 'normal', title: '移动端设置页整理', labels: [L.mobile, L.design], assignee: 'chen',
    body: ['按 docs/design/mobile.md 把设置页拆成通知、记忆、版本三组。'] },

  // —— Review
  { key: 'i-quote-artifact', status: 'review', priority: 'normal', title: '引用 Artifact 片段发给 Bot 时丢失版本号', labels: [L.chat, L.bug], assignee: 'bot:frontend', run: 'waiting',
    body: ['在 Artifact 里选中一段点「引用」，发出去的消息里 version 是空的，Bot 回复引用了最新版而不是我看的那版。'],
    pullRequests: [pr(851, 'open', 'fix(chat): keep the artifact version in quotes')] },
  { key: 'i-push-finished', status: 'review', priority: 'low', title: '「线程完成」推送在手机前台时也弹出', labels: [L.mobile], assignee: 'lin',
    body: ['pushWhen=away 时，App 在前台仍然收到系统横幅。'],
    pullRequests: [pr(118, 'open', 'fix: respect pushWhen=away in foreground', 'mikka-demo/mobile'), pr(119, 'draft', 'test: foreground push matrix', 'mikka-demo/mobile'), pr(121, 'closed', 'wip: foreground detection', 'mikka-demo/mobile')] },
  { key: 'i-billing-receipt', status: 'review', priority: 'high', title: '流式回复中断后用量没有记账', labels: [L.billing, L.bug], assignee: 'zhou', due: 2,
    body: ['用户在回复中途点停止，hosted_usage 里没有这一次的记录。', '应该按已经收到的 token 记账，而不是等 finish 事件。'],
    pullRequests: [pr(838, 'open', 'fix(billing): account early stream receipts')] },

  // —— Done
  { key: 'i-desktop-blur', status: 'done', priority: 'normal', title: '半透明窗口里对话框背后的模糊层去掉', labels: [L.desktop, L.design], assignee: 'bot:frontend', run: 'succeeded',
    body: ['macOS 半透明窗口下，对话框背后再叠一层 backdrop-blur 会糊成一片。'], pullRequests: [pr(790, 'merged', 'fix(desktop): no backdrop blur under dialogs')] },
  { key: 'i-openui-retired', status: 'done', priority: 'high', title: '旧回复里的 ShadcnCard 组件不再渲染', labels: [L.chat, L.regression], assignee: 'bot:backend', run: 'succeeded',
    body: ['组件改名后，历史消息里的 ShadcnCard / BeTimeline 显示成源码。保留旧名的解析。'], pullRequests: [pr(781, 'merged', 'fix(openui): parse retired component names')] },
  { key: 'i-turnstile', status: 'done', priority: 'normal', title: '邮箱注册没有带 Turnstile token', labels: [L.auth], assignee: 'lin',
    body: ['注册和「重新发送验证邮件」都要带 token，否则生产 403。'], pullRequests: [pr(760, 'merged', 'fix(auth): send Turnstile token')] },
  { key: 'i-sub-1', status: 'done', priority: 'normal', title: '通知分组', labels: [L.mobile], assignee: 'chen', parent: 'i-subtask-parent', body: ['把推送开关放到「通知」组。'] },
  { key: 'i-sub-2', status: 'done', priority: 'normal', title: '版本页显示 OTA 更新', labels: [L.mobile], assignee: 'bot:mobile', parent: 'i-subtask-parent', body: ['显示当前 build 和正在运行的更新。'] },
  { key: 'i-sub-3', status: 'todo', priority: 'normal', title: '记忆开关文案对齐桌面端', labels: [L.mobile], assignee: 'chen', parent: 'i-subtask-parent', body: ['跟设置 › 记忆 用同一套文案。'] },

  // —— Canceled / duplicate (the 已隐藏 lane)
  { key: 'i-canceled', status: 'canceled', priority: 'low', title: '侧栏加「最近访问」分组', labels: [L.design], assignee: null, body: ['和 Bot 列表重复，不做。'] },
  { key: 'i-duplicate', status: 'duplicate', priority: 'normal', title: '桌面端登录后又跳回登录页', labels: [L.auth], assignee: null, duplicateOf: 'i-signin-loop', body: ['同「拒绝 handoff 后登录页死循环」。'] },
]

/** Personal tasks (lock on the card). Personal tasks show on every board of the owner, so keep this short. */
export const PERSONAL_ISSUES = [
  { key: 'p-review-notes', status: 'todo', priority: 'normal', title: '整理本周 code review 里反复出现的问题', labels: [], assignee: 'me', due: 4,
    body: ['迁移顺序、R-40 文案、测试里的固定 sleep。写成 checklist 放进 REVIEW.md。'] },
]

/** Demo computers. Settings › 设备 lists them; none has a token, so no daemon can act as one. */
export const DEVICES = [
  // All demo devices are disabled: dispatch and lease takeover only pick enabled ones. `online` keeps
  // lastSeenAt ahead of now so the row reads online.
  { key: 'd-mbp', name: 'MacBook Pro（演示）', hostname: 'alex-mbp.local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', online: true, autoSchedule: false,
    harnesses: [{ harness: 'claude_code', installed: true, version: '2.4.1' }, { harness: 'codex', installed: true, version: '0.61.0' }] },
  { key: 'd-server', name: 'build-01（演示）', hostname: 'build-01', deviceType: 'server', platform: 'linux', arch: 'x64', lastSeenMinutes: 42, autoSchedule: true,
    harnesses: [{ harness: 'codex', installed: true, version: '0.61.0' }] },
  { key: 'd-old', name: 'Mac mini（演示）', hostname: 'mini.local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', lastSeenMinutes: 60 * 24 * 9, autoSchedule: null,
    harnesses: [{ harness: 'claude_code', installed: true, version: '2.1.0' }] },
]

/** Coding agents the threads run on (settings › Agents lists these per person). */
export const AGENTS = [
  { key: 'ag-claude', name: 'Claude Code · 演示', harness: 'claude_code', device: 'd-mbp' },
  { key: 'ag-codex', name: 'Codex · 演示', harness: 'codex', device: 'd-server' },
]

const text = (delta, id = 't1') => ({ type: 'text-delta', id, delta })
const tool = id => ({ type: 'tool-input-available', toolCallId: id })

/**
 * Threads. `minutesAgo` is when it started; finished ones also have `minutes` of run time.
 * Running/waiting threads carry no lease, so run recovery never reclaims them.
 */
export const RUNS = [
  { key: 'r-board-scroll', issue: 'i-board-scroll', bot: 'frontend', agent: 'ag-claude', status: 'running', minutesAgo: 25,
    prompt: '修复看板最后一张卡被横向滚动条遮挡\n只改列内容区的底部留白，不改 300px 列宽。',
    lastReply: '已在 macOS「始终显示滚动条」下复现，正在补 Playwright 截图对比。',
    chunks: [text('先复现：在 1280×800、侧栏展开时打开看板。'), tool('a'), tool('b'), text('已复现，遮挡约 12px。改 KanbanColumnContent 的 padding-bottom。', 't2'), tool('c'), text('已在 macOS「始终显示滚动条」下复现，正在补 Playwright 截图对比。', 't3')] },
  { key: 'r-flaky-daemon', issue: 'i-flaky-daemon', bot: 'daemon', agent: 'ag-codex', status: 'running', minutesAgo: 50,
    prompt: '修复 sandbox.verify 测试在 CI 上的偶发超时\n先用 --repeat 50 复现。',
    lastReply: '#61 的 CI 在跑，第 3/4 个 job 已通过。',
    chunks: [text('本地 --repeat 50：失败 7 次，全部是 verify 先于 git config 写入。'), tool('a'), tool('b'), tool('c'), text('改为 await writeGitConfig，并去掉测试里的 sleep(200)。', 't2'), tool('d'), text('#61 的 CI 在跑，第 3/4 个 job 已通过。', 't3')] },
  { key: 'r-unread', issue: 'i-unread-dot', bot: 'frontend', agent: 'ag-claude', status: 'waiting_input', minutesAgo: 95,
    prompt: '切换工作区后 Bot 列表的未读红点残留',
    lastReply: 'conversation_reads 的 key 没带工作区。要按工作区拆开吗？这会让旧的已读位置失效一次。',
    chunks: [text('查了 conversation_reads：主键是 (userId, conversationId)，Bot 的 conversationId 在两个工作区里相同。'), tool('a'), tool('b'), text('conversation_reads 的 key 没带工作区。要按工作区拆开吗？这会让旧的已读位置失效一次。', 't2')] },
  { key: 'r-testflight', issue: 'i-testflight', bot: 'mobile', agent: 'ag-claude', status: 'waiting_input', minutesAgo: 140,
    prompt: 'TestFlight 冷启动白屏 2 秒\n先量首帧时间，再改。',
    lastReply: '首帧从 2.1s 降到 0.6s。要把 SecureStore 的其余读取挪到首帧之后吗？',
    chunks: [text('模拟器冷启动 20 次，首帧中位数 2.1s。'), { type: 'data-computer', data: { runId: '{{run:r-testflight}}', botId: '{{bot:mobile}}', task: '在模拟器里冷启动 20 次，记录首帧时间' } }, tool('a'), text('首帧从 2.1s 降到 0.6s。要把 SecureStore 的其余读取挪到首帧之后吗？', 't2')] },
  { key: 'r-quote', issue: 'i-quote-artifact', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 20, minutes: 34,
    prompt: '引用 Artifact 片段时保留版本号',
    lastReply: 'PR #851 已提交，等评审。',
    chunks: [text('根因：quote.ts 把 version 转成了字符串，空值变成 ""。'), tool('a'), tool('b'), text('PR #851 已提交，等评审。', 't2')], artifacts: ['a-quote-notes'] },
  { key: 'r-signin-loop', issue: 'i-signin-loop', bot: 'qa', agent: 'ag-codex', status: 'failed', minutesAgo: 60 * 5, minutes: 12,
    prompt: '复现桌面端拒绝 handoff 后的登录循环，并写一个失败的 e2e',
    lastReply: '构建桌面测试包时签名失败，没能跑到用例。',
    error: 'electron-builder: code signing identity not found in keychain',
    chunks: [text('开始构建桌面测试包。'), tool('a'), { type: 'error', errorText: 'electron-builder: code signing identity not found in keychain' }] },
  { key: 'r-group-route', issue: 'i-long-title', bot: 'backend', agent: 'ag-codex', status: 'running', minutesAgo: 35,
    prompt: '群聊同时提及多个 Bot 时为每个 Bot 排一个 turn\n历史消息不补发。',
    lastReply: '测试已补：3 个提及各自一个 turn。正在改 route.botIds。',
    chunks: [text('先写失败的测试。'), tool('a'), text('测试已补：3 个提及各自一个 turn。正在改 route.botIds。', 't2')] },
  { key: 'r-desktop-blur', issue: 'i-desktop-blur', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 50, minutes: 18,
    prompt: '半透明窗口里去掉对话框背后的模糊层', lastReply: '已合并 #790。',
    chunks: [text('删掉 Dialog overlay 的 backdrop-blur，半透明窗口下改用纯色遮罩。'), tool('a'), text('已合并 #790。', 't2')], artifacts: ['a-blur-compare'] },
  { key: 'r-openui', issue: 'i-openui-retired', bot: 'backend', agent: 'ag-codex', status: 'succeeded', minutesAgo: 60 * 70, minutes: 41,
    prompt: '旧回复里的 ShadcnCard 等组件名继续解析', lastReply: '已合并 #781，历史消息恢复渲染。',
    chunks: [text('在 legacy catalog 里保留旧名，映射到新组件。'), tool('a'), tool('b'), text('已合并 #781，历史消息恢复渲染。', 't2')] },
  { key: 'r-release-notes', issue: null, bot: 'release', agent: 'ag-codex', status: 'succeeded', minutesAgo: 60 * 3, minutes: 6,
    prompt: '起草桌面 0.9.5 发版说明', lastReply: '草稿已提交为 Artifact。',
    chunks: [text('汇总 0.9.4 以来合入的桌面相关 PR。'), tool('a'), text('草稿已提交为 Artifact。', 't2')], artifacts: ['a-release-notes'] },
  { key: 'r-e2b-cancel', issue: 'i-e2b-quota', bot: 'backend', agent: 'ag-codex', status: 'cancelled', minutesAgo: 60 * 26, minutes: 3,
    prompt: '复现 E2B 429', lastReply: '已停止：换成本地 mock 复现。', chunks: [text('E2B 返回 429，已停止。')] },
]

/** Artifacts the threads handed over; the content is stored inline. */
export const ARTIFACTS = [
  { key: 'a-release-notes', kind: 'markdown', title: '桌面 0.9.5 发版说明（草稿）', author: '发布经理', versions: [
    '# 桌面 0.9.5\n\n## 修复\n\n- 拒绝浏览器授权后登录页循环\n- 半透明窗口下对话框背后的模糊\n',
    '# 桌面 0.9.5\n\n## 修复\n\n- 拒绝浏览器授权后，登录页不再反复打开浏览器\n- 半透明窗口下，对话框背后不再叠加模糊\n\n## 改进\n\n- 更新在后台下载，头像上方出现「重启以更新」\n\n## 已知问题\n\n- 首次启动在 macOS 26.0 上可能需要两次授权\n',
  ] },
  { key: 'a-quote-notes', kind: 'markdown', title: '引用丢失版本号：根因分析', author: 'Mikka Frontend', versions: [
    '# 引用丢失版本号\n\n## 现象\n\n引用 Artifact 第 2 版的片段，Bot 回复引用的是第 3 版。\n\n## 根因\n\n`lib/artifacts/quote.ts` 序列化时 `String(selection.version ?? \'\')`，空值变成空字符串，解析时回落到最新版。\n\n## 修复\n\n直接传数字；历史消息的空版本仍按最新版处理。\n',
  ] },
  { key: 'a-blur-compare', kind: 'html', title: '对话框遮罩前后对比', author: 'Mikka Frontend', versions: [
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>对话框遮罩前后对比</title><style>body{font:14px system-ui;margin:24px;color:#222}div{display:flex;gap:16px}figure{margin:0;flex:1;border-radius:8px;padding:16px;background:#f4f4f5}.a{backdrop-filter:blur(12px);background:rgba(244,244,245,.6)}</style><h1>对话框遮罩</h1><div><figure class="a"><b>改动前</b><p>backdrop-blur 叠在半透明窗口上，文字发糊。</p></figure><figure><b>改动后</b><p>纯色遮罩，背后内容清晰可辨。</p></figure></div></html>',
  ] },
]

/** Profile facts for the 记忆 page. Personal by design (facts never belong to a workspace), so only a few. */
export const FACTS = [
  { key: 'f-small-prs', kind: 'preference', subject: '喜欢小而单一的 PR', value: { note: '一个 PR 只解决一个问题，迁移单独提' }, confidence: 0.86 },
  { key: 'f-pnpm', kind: 'tool', subject: 'pnpm', value: { version: '10.34' }, confidence: 0.92 },
  { key: 'f-review-time', kind: 'routine', subject: '上午集中 review PR', value: { window: '09:30–11:00' }, confidence: 0.7 },
  { key: 'f-release', kind: 'deadline', subject: '桌面 0.9.5 Beta', value: { date: 'friday' }, confidence: 0.8 },
]

/** 建议 rows. Dated more than a day back, so the 08:00 briefing never picks them up. */
export const SUGGESTIONS = [
  { key: 's-review', source: 'github', action: 'review', title: 'fix(billing): account early stream receipts', actionTitle: '评审 周宁的 PR：流式中断记账', actor: '周宁', level: 'high', required: true, hoursAgo: 26, url: 'https://github.com/mikka-demo/web/pull/838' },
  { key: 's-linear', source: 'linear', action: 'handle', title: '桌面端拒绝 handoff 后登录页进入死循环', actionTitle: '处理 林晓分配的任务：登录死循环', actor: '林晓', level: 'critical', required: true, hoursAgo: 30, url: 'https://linear.app/mikka-demo/issue/APP-12' },
  { key: 's-slack', source: 'slack', action: 'reply', title: '0.9.5 周五能发吗？我们要给客户演示', actionTitle: '回复 Kevin：0.9.5 发版时间', actor: 'Kevin', level: 'ask', required: false, hoursAgo: 40, url: null },
  { key: 's-gmail', source: 'gmail', action: 'read', title: 'Your Apple Developer Program membership renews in 7 days', actionTitle: '查看 Apple 开发者账号续费提醒', actor: 'Apple Developer', level: 'normal', required: false, hoursAgo: 50, url: null },
  { key: 's-notion', source: 'notion', action: 'read', title: '11 月路线图（草稿）有 3 条新评论', actionTitle: '查看 路线图草稿的 3 条新评论', actor: '陈予', level: 'normal', required: false, hoursAgo: 75, url: null },
]

/** What each bot remembers (coordinator_sessions.memory, Markdown lines). */
export const BOT_MEMORY = {
  frontend: '- 看板列宽固定 300px（R-25），不要改。\n- 截图对比用 1280×800 和 1440×900 两档。',
  backend: '- 迁移文件必须排在 main 最新迁移之后。\n- 历史群消息不补发。',
  daemon: '- 测试里不要写固定 sleep。',
  release: '- Beta 首日灰度 20%。',
}
