# 教训记录

本文件按事件日期保留当时的现象和结论。当前操作遵循
[`AGENTS.md`](../AGENTS.md)、[开发流程](../docs/dev-workflow.md)和
[凭据约定](../docs/infisical-cloud.md)。引用旧命令、运行时或发布配置前，
先按这些现行指南和实际源码重新核对。

## 2026-10-20 调研需要登录的线上应用时，别在登录墙前停下

**发生了什么**：要分析 app.comma.surf 的真实字体，用 chrome-devtools MCP 打开却只看到登录页。
我先去猜「MCP 的 profile 是全新的所以没登录」，又绕去扒 JS bundle 找 class 名，
被用户纠正：**直接复制浏览器 profile**。

**两个真正的坑**：

1. **先确认用户在哪个浏览器里登录的**。我默认是 Chrome，把
   `~/Library/Application Support/Google/Chrome` 全翻了一遍也没有 comma.surf 的 cookie。
   实际是 **Brave**（`~/Library/Application Support/BraveSoftware/Brave-Browser`）。
   截图里的浏览器不等于 Chrome —— `ps aux | grep -iE "Brave|Chrome|Arc|Edge"` 先看一眼。

2. **chrome-devtools MCP 启动的 Chrome 带 `--use-mock-keychain`**，
   读不了真实钥匙串里的 cookie 解密密钥，所以**复制 cookie 文件进 MCP 的 profile 没用**。
   必须自己起一个不带该参数的实例，且**用同一个浏览器**（Brave 的 cookie 要用
   "Brave Safe Storage" 钥匙串项解密，换 Chrome 起也解不开）。

**可复用的做法**：

```bash
# 1. 复制 profile（只拷 cookie 与存储，别拷整个目录）
DST=/tmp/xxx-prof; mkdir -p "$DST/Default"
cp "$SRC/Local State" "$DST/"
cp "$SRC/Default/Cookies" "$DST/Default/"
cp -R "$SRC/Default/Local Storage" "$DST/Default/"

# 2. 用原浏览器 + 调试端口起一个独立实例（不带 --use-mock-keychain）
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --user-data-dir="$DST" --remote-debugging-port=9333 \
  "--remote-allow-origins=*" --no-first-run --disable-sync --disable-extensions
```

**收尾**：拷出来的 profile 含用户**全站 cookie**，用完必须删掉
（`rm -rf /tmp/xxx-prof`，以及 MCP profile 里那份）。`pkill` 时务必带上
`user-data-dir=` 精确匹配，别误杀用户自己开着的浏览器。

**顺带**：查「实际渲染字体的物理文件名」不要靠 `getComputedStyle().fontFamily`
（那只是声明的字体栈），要用 CDP 的 **`CSS.getPlatformFontsForNode`**。
调用前必须先 `DOM.getDocument` 填充节点表，否则报 "Could not find node with given id"。

---

## 2026-10-20 不要用一个窗口的查询结果去概括整体状态

**发生了什么**：我说「CI 从来没跑起来过，GitHub Actions 因账单全停」，
并把这个结论写进了 PR #3 的描述。用户反问「怎么可能，我已经公开仓库了呀」。

**真相**：仓库是 public，CI 完全正常，账单问题只在 21:44–22:51 卡了一段。
我跑的是 `gh run list --limit 8`，那 8 条**恰好全落在故障窗口内**，
于是我把「这 8 条失败」当成了「从来都是失败」。

**规则**：

1. **说「一直」「从来」「总是」之前，必须拉全量历史再下结论**。
   `gh run list --limit N` 的 N 是个陷阱 —— 先看时间跨度够不够，
   或者直接按结论分组统计：`--json conclusion --jq 'group_by(.conclusion)[] | ...'`。
   本次只要跑一句 `group_by` 就能看到「success: 9 次」，立刻发现结论错了。
2. **临时性故障不要写成系统性故障**。看到 billing/quota/rate-limit 这类错误，
   先看时间分布：如果前后都有成功的运行，那是临时抖动，不是坏掉。
3. **错误结论一旦写进 PR 描述 / commit message，就进了仓库历史**，
   发现后要主动去改（`gh pr edit <n> --body`），不能只在对话里更正。

**为什么容易犯**：`gh run list` 默认按时间倒序，最新的一批最显眼。
故障窗口通常就在最近，所以「最近的都失败」会强烈暗示「一直失败」。
这是个采样偏差，不是数据问题。

## 2026-10-20 配 `*_URL` 类环境变量前，先证明域名属于这个部署

**发生了什么**：给 Vercel 三个环境配 `BETTER_AUTH_URL` 时，我把 Production 设成了
`https://orvilo.aspectlylabs.com` —— 依据只是「Cloudflare 有 `aspectlylabs.com` 这个 zone，
且它是 Orvilo 线上域名」。实际上：

- 这个 Vercel 项目 (`new-base-nova-project`) 的域名列表**只有** `new-base-nova-project-ten.vercel.app`；
- `orvilo.aspectlylabs.com` 返回 **10 字节**的 `Orvilo API`，是 Cloudflare 上的另一个东西，
  响应里没有 `x-vercel-id`。

**两个坑，第二个更隐蔽**：

1. **别从"域名归属"推断"这个项目部署在哪个域名"**。
   核实方法二选一：`GET /v9/projects/{id}/domains?teamId=...`，或
   `curl -sI <域名>` 看有没有 `x-vercel-id` 头（有才是 Vercel 在服务）。
   Cloudflare 开了代理时 `server: cloudflare` 不代表后端不是 Vercel，但**缺 `x-vercel-id`
   基本可以断定不是**。

2. **代码里已经有 fallback 时，别再加冗余的 env 变量**。先读 `lib/auth-config.ts` 的
   `resolveAppOrigin`：Preview 默认用自己的 `VERCEL_URL`，Production 用
   `VERCEL_PROJECT_PRODUCTION_URL`；Preview 登录经 `BETTER_AUTH_OAUTH_PROXY_URL`
   回调中心（见 `docs/cloud-preview.md`）。

**规则**：

1. 设 `*_URL` / `*_ORIGIN` 类变量前，先证明这个域名**真的在服务当前部署**。
2. 加 env 变量前先读一遍消费它的代码。有 fallback 链的地方，
   env 变量只在该环境**拿不到 system var** 时才需要（本地 dev 就是这种：
   没有 `VERCEL_*`，所以 Development 保留 `http://localhost:3000` 是对的）。
3. **`vercel env add` 在 Production/Preview 默认存成 Secret（write-only），存完读不回来**，
   没法校验有没有混进换行。非敏感的 URL 用 `--type config` 存，
   以后能核对；`vercel env pull` 对 Secret 只会写 `[SENSITIVE]` 占位符。
4. 改坏了不一定要立刻重新部署：官方文档说 env 变更**只对新的部署生效**，
   所以旧部署仍用旧值。发现配错时，在下次部署前改回来就来得及 —— 但也别指望
   「已生效的坏值」会自己回滚。
5. **`vercel env add` 的用法**：环境是 `-e/--environment` 标志，**不是位置参数**
   （`vercel env add NAME --environment production --type config --value "..."`）。
   写 `vercel env add NAME production` 会静默失败。用 `--value` 而不是
   `echo ... | vercel env add` —— 前者从 argv 取完整字符串，
   不存在「stdin 尾随换行是否被 trim」的疑问，配合 `--type config` 还能回读校验。

## 2026-10-20 交付报告：第一屏是清单逐项结果，不是我的自查过程

**发生了什么**：用户指着清单说「后面两个，直接都做了，做完了告诉我」。两件我都做完了，
但交付报告用大半篇幅讲我自己之前的配置错误、域名归属调查、Vercel 文档考据，
最后还抛了一个「需要你决定的一件事」。用户读完的直接反应是：要的两件事没看到，
满屏都是预览环境和提问。

**规则**：

1. 「做完了」的报告**第一屏就是清单逐项 ✅/❌**，证据、背景、自查放后面。
2. **交付报告不以提问结尾**。真要用户拍板的事单独一句放最后，
   别包在正文里让它看起来像任务没完成。
3. 自查出来的错误要讲，但压成一句（「顺带修了我之前配错的两处」），不占正文。
4. 用户说「后面两个」时，**回去读自己上一条消息里那份清单的原文**，
   按序号对上，别靠记忆。

---


## 2026-10-20 用户偏好：不要全宽水平长线

**发生了什么**：截图指出表格头下方那条贯穿整行的分割线，明确说「agent 很喜欢用这种长线，
我喜欢不带线的」。

**规则**：

1. 业务 UI 不做全宽水平分割线：不用 `border-t/b/y`、`divide-y`、水平 `<Separator />`、
   `h-px bg-*`。分组用间距（`gap-*`）或背景（`bg-muted/*`）。
2. 竖线（`border-l/r`、`orientation="vertical"`）和盒状边框（`border`）可以保留。
3. 这条已经落在 `style/no-horizontal-rule`；先跑 `node scripts/lint-ui.mjs`，不要靠肉眼。
4. 例外（已在 `scripts/ui-policy.mjs` 豁免）：设置页的 `divide-y` 行分隔（`docs/settings.md`）、
   任务页头部线与评论卡片内的线（R-61/R-63）、未读「新」分隔线。设置页字段不要用 `bg-muted` 分组。


---

## 2026-10-21 i18n：key 对齐不等于 key 存在

**发生了什么**：`messages/zh-CN.json` 与 `en.json` 的 key 完全对齐、CJK 扫描全绿，
但浏览器里出现了 `Nav.toggleSidebar`、`Editor.slash.text.title` 这类原始 key。
原因是代码引用了一个两边都没有的 key——next-intl 会原样渲染 key，而 CJK 扫描只看中文、比较器只看两份字典。

**规则**：

1. 字典完整性检查必须包含「代码用到的 key 是否存在于字典」，不能只比较两个 locale。
2. 从 `useTranslations('Ns')` / `getTranslations(...)` 推断命名空间，校验字面量 `t('key')`；
   模板字符串 key 与同名变量多命名空间的情况跳过，避免误报。
3. 截图评审或 API 验收时顺手扫 `\b(Namespace)\.[a-z0-9_.-]+`，这是发现缺 key 最快的手段。
4. 动态拼接的 key（slash items、枚举）要么列白名单，要么在本地截图里逐项确认。

## 2026-10-21 Turbopack 缓存被强杀后会永远卡在 Starting

**发生了什么**：反复 `TaskStop` 开发服务器后，`next dev` 进程 CPU 很高但端口不响应，
日志出现 `inner_of_upper_lost_followers` 的 tokio panic。

**规则**：遇到这种状态先 `rm -rf .next` 再启动，不要在「等它编译完」上浪费时间；
`pkill -f "next dev"` 后确认端口释放，避免新实例换端口导致 better-auth origin 校验失败。

## 2026-10-21 `[locale]/not-found.tsx` 需要 catch-all 才可达

**发生了什么**：`app/[locale]/not-found.tsx` 写了却永远不渲染；`/en/nonexistent` 直接落到静态的 `app/global-not-found.tsx`（双语但 `<html lang="zh-CN">`）。

**规则**：顶层动态段下的 404 要加 `app/[locale]/[...rest]/page.tsx` 调 `notFound()`；
验证时看 HTTP 状态（404）、浏览器 `document.documentElement.lang` 与页面文案三者是否一致。
另外 `JSON.parse` 会静默丢掉重复 key，检查器应能发现重复键，或至少用 `jq`/脚本单独查一次。


## 2026-10-28 README 的「已上线」不能只看代码是否存在

**发生了什么**：README 仍把跨设备接续、连接应用审批操作、多 bot 写成「规划中」，
而这几项早已合并；反过来，云端电脑、原生 Coordinator、iOS App 的代码也在 main 上，
但分别被生产 flag、环境变量和 TestFlight 验收挡住，不能算上线。

**规则**：

1. 判断是否上线至少看三层证据：PR 是否 merged、是否有 feature flag / 环境变量门禁、
   对应 issue 是否仍 OPEN。
2. **生产环境变量和线上接口才是最终证据**：`vercel env ls production` 看开关，
   再请求生产路由看返回码（禁用是 503，启用但未登录是 401）。issue OPEN
   只说明验收没收尾，不等于功能没开。
3. **带日期的验收文档会过期**。这次 E2B 就是被 10-27 的「production flags remain off」
   误导，而 10-27 晚些时候生产变量已经打开；必须以当前环境为准。
4. 合并 PR 的描述里如果记录了生产回调验证（如 Slack #51），才算线上可用；
   仅有代码和单测只算「已实现」。
5. 文档里「规划中」的条目要按能力拆分：同一块能力可能一部分已上线
   （邮件/日历审批），另一部分仍未上线（文档、Slack 操作）。
6. 改 README 图表前先找生成脚本（`scripts/generate-diagrams.mjs`），
   不要手改 SVG；改完渲染明暗、中英四种组合抽查。
7. 区分「没开发」和「开发了但没合入」：查 open PR 和相关分支
   （`gh pr list --state open`、`git branch -r | grep`）。Plan 里的虚线
   只代表没上线，不代表没有实现。

## 2026-10-29 设置页：缺后端不等于「即将推出」

- 纠正：我把所有缺后端的设置项一律标「即将推出」，用户指出简单的应该顺手做掉。
- 规则：遇到「设计有、后端没有」，先按工作量分三档：
  1. 一个 server action / 一列字段 / 只读聚合 → 直接实现，设计里画成可用。
  2. 不可逆或级联（删账户、删工作区、删团队、移除成员）、需要新子系统（计费、导出+邮件、文件存储） → 「即将推出」，并写清缺什么。
  3. 拿不准 → 先查表结构和调用方，再归档，不凭名字猜。
- 同时：中文文案的「请」不能机械删除，要看旁边有没有按钮承担动作（见 docs/design/copy.md C-04）。

## 2026-10-31 产品自身的运行依赖不能甩给用户

- 纠正：Oracle 缺 socat、rg 导致 daemon 不上报 Agent，我的首选修法是手动 `apt install` 救这一台，用户指出安装 daemon 时就该装好这些依赖。
- 规则：定位到「环境缺依赖」后，先问为什么安装流程没有处理它。首选修安装流程；手动命令只是临时救急，不算修复。
- 同时：读可能含凭据的文件时不要用正则脱敏，只取需要的字段（如 `jq -r .deviceId`）。这次脱敏正则没匹配上，device credential 明文进了对话记录。

## 2026-11-10 迁移测试要重放真实 SQL，切片不要留死 action

- 纠正：PAT 回填测试一开始把 `update ... where scopes is null` 手抄到临时表，删掉真实迁移里那行测试照样绿；reviewer 要求用 `set local search_path` 在事务里重放 `drizzle/20261110230000_api_tokens.sql`，断言存量行变 `legacy:full`、新行默认公开、混合 audience 被 CHECK 拒绝。
- 规则：
  1. 数据迁移的测试必须执行真实迁移文件（临时 schema + rollback 可隔离），不要复制 SQL 自证。
  2. 只为测试存在的 fail-open 缺省要改成 fail-closed：新 token 默认公开 scope，pre-M4 token 用显式 helper。
  3. 删除未接线模块的标准同样适用于新增 action：没有调用方就只留 store 函数 + 测试，等 UI 接入时再加 server action。

## 2026-11-18 UI 审计：先看渲染，再谈 token；文案迁移要连带修测试和 locale

- 纠正：第一轮 UI 审计只查了 token / class 名，漏掉了真正难看的版面缺陷（PR 列表行没有固定列，标题和状态互相挤）。用户拿截图指出后才发现「对齐」这一整类问题。
- 规则：
  1. 审计列表 / 表格页面时，必须逐列问「这一列有没有固定宽度」，不要只看 class 是否用了 token。
  2. 控件高度这类跨组件一致性可以做成 CI 规则（`scripts/control-size-policy.mjs`），否则下次又会漂。
- 纠正（文案迁移）：把移动端硬编码中文字面量搬进 catalog 后，一批测试挂了，因为断言写死了中文字面量，而本机 locale 是 en-US。
- 规则：
  1. 迁移文案时同步把测试改成从 catalog 读期望值，不要改成 `getMobileMessages('zh-CN')` 写死中文——那样只是把中文搬了个地方。
  2. 顺手会暴露真 bug：`chat-failure.ts`、`run-error.ts`、`sign-in-error.ts`、`FailedReply.tsx` 直接 `import messages from 'messages/zh-CN.json'`，英文设备会显示中文。凡是移动端直接 import zh-CN 的地方都要改成 `mobileMessages`。
  3. 新建文案 key 前先搜一遍现有 catalog：`MobileCore.replyRetry` 是我新加的重复命名空间，实际已有 `Coordinator.replyRetry` 在用。
  4. 冻结基线（`scripts/mobile-i18n-baseline.mjs`）要双向校验：既拦新硬编码，也拦「已迁移但没删行」，否则清单不会真的只减不增。

## 2026-11-18 收尾：移动端有自己的 typecheck，根 tsconfig 不覆盖

- 纠正：我只跑了根 `npx tsrs --noEmit`，漏了 `npx tsrs --noEmit -p apps/mobile/tsconfig.json`。reviewer 一跑就发现 5 个错误：`import { Inbox }` 与 `function Inbox()` 重名（Metro 打包会直接炸）、`@expo/ui` 的 Button/Image 不接受 RN 的 `accessibilityLabel`/`accessibilityElementsHidden`（要走 modifiers 的 `accessibilityLabel()`/`accessibilityHidden()`）、以及 `MobileCore.send` 这个 key 根本不存在（应复用 `Coordinator.send`）。
- 规则：
  1. 这个仓库是 pnpm workspace，`apps/mobile` 有独立 tsconfig，改动涉及它时必须两个 typecheck 都跑。
  2. 改移动端图标时先看 `lucide-react-native` 的导出名是否和本文件的组件/函数同名。
  3. `@expo/ui/swift-ui` 的无障碍属性是 modifiers，不是 RN props。
  4. 新增 catalog key 前先 `grep` 一遍同类 namespace：`Coordinator.pendingActions.*` 已经覆盖了 pending action 卡片的全部字段，我在 `MobileCore` 里重造了 23 个。
  5. 新加的 policy 测试要接进 `package.json` 的 `test:ui-policy`，否则永远不会在 CI 里跑。

## 2026-11-18 对比度不能手算，必须写成测试；`.pathname` 是本仓库的复发 bug

- 纠正：`--tertiary` 第一版按「页面底」算到 4.85:1 就收工，深色实际 4.498:1（未取整比较会判失败），而真正承载它的 `bg-muted/80` chip 上只有 3.97:1。reviewer 自己算出来才发现。
- 规则：
  1. 颜色 token 的可读性写成 `scripts/contrast.test.mjs` 这种从 `globals.css` 解析、按 WCAG 公式计算的测试，并且要覆盖**实际承载它的表面**（页面、card、`bg-muted` 整体、`bg-muted/80` 合成色），不是只算页面底。
  2. 新写的检查必须做一次变异验证（把旧值改回去，确认它会红），否则不知道它在测什么。
  3. 报错里用三位小数：两位会把 4.498 显示成「4.50 needs 4.5」，看起来像测试自己坏了。
- 纠正（复发 bug）：`lib/ui-overlay.test.mjs` 用 `new URL('..', import.meta.url).pathname` 当根目录，本 worktree 路径含空格，`readdirSync` 直接 `ENOENT` 到 `%20`。这已经是本会话第三次遇到（`mobile-i18n-baseline.mjs`、`message-gesture.test.mts`、现在这个）。
- 规则：
  1. 凡是把 URL 变成文件系统路径，一律 `fileURLToPath`；`pathname` 只用于 URL 语义。
  2. 改完 policy 测试要跑**整条** `test:ui-policy` 命令串，而不是只跑自己新加的那几个文件——`ui-overlay.test.mjs` 就藏在这条命令串的末尾。

## 2026-11-19 CI 才发现的测试：本机 locale 掩盖了「测试写死中文」

- 现象：PR 推到 CI 后 `Core unit checks` 红，`lib/chat-failure.test.ts` 断言 `{text:'回复未完成，请重试'}`，而 CI 机器 locale 是 en-US，实际拿到 `'Reply did not finish. Please try again.'`。本机跑绿是因为本机 locale 是 zh-CN。
- 根因：迁移实现（`apps/mobile/lib/chat-failure.ts` 改用 `mobileMessages`）时，只改了 `apps/mobile/tests/*.test.mts`，漏了根目录 `lib/chat-failure.test.ts`——它直接 import 移动端实现，属于同一批断言。
- 规则：
  1. 把「测试改成读 catalog」时，要按 `grep -rn "<中文原文>"` 全仓库扫一遍断言，不能只改报错的那一个目录；根 `lib/` 下也有直接测移动端实现的测试。
  2. 本机 locale 会让这类测试假绿。判断标准是「断言里有没有字面量文案」，不是「本机跑没跑绿」。
  3. 修完再推一次，等 CI 全绿再 merge；不要因为「本机绿」就认为改动无关。

## 2026-11-19 一个布尔值管三个不相关的 UI 区块 = 回归温床

- 现象：#2835 把「Bot 线程在主聊天打开」做成默认路径（`?mainThread=`），同一 commit 又把 `isConversation` 改成 `!mainThreadId && !selected && ...`。结果右栏、工作区 tab、窗口栏的「打开右栏」三处同时消失——它们都 gate 在同一个布尔值上。用户看到的就是「右侧边栏没有了」。
- 根因：`isConversation` 的语义被偷换成了「中心是 chat 而不是 thread」，但三处消费方要的是「中心是不是一个会话」。
- 规则：
  1. 一个布尔值被三处不相关的 UI 读取时，先问它到底在回答什么问题；把「是不是会话」和「是 chat 还是 thread」拆成两个判断。
  2. 布局回归必须用**渲染断言**锁住（`querySelector('[data-context-panel]')`），不能只测「页面没崩」。
  3. 新写的回归测试要做变异验证：把旧代码放回去确认变红，否则不知道它在测什么。
  4. 跨组件共享的 context 要从**叶子模块**导出，不要从已经 import 了消费方的模块里导出（会形成 cycle）——`conversation-panels-context.ts` 就是这么拆出来的。

## 2026-11-19 "grep 不到 importer" 不能用来删依赖

- 现象：审计把 `unstorage` 判成死依赖删掉（源码里 grep `unstorage` 零命中），CI 上 Nitro 构建全线失败：`unstorage is not installed. It is required for KV storage (nitro/kv)`。`lib/agent-images-server.ts:3` 用的是虚拟模块 `nitro/kv`，真正的包由 Nitro 在构建期注入。
- 根因：把"源码里没有 import"等同于"运行时不需要"。框架的约定式/虚拟模块依赖（Nitro `nitro/kv`、Next 的 `next/font`、Vite 插件注入的包）永远不会出现在 grep 结果里。
- 规则：
  1. 删依赖前，除了 `grep 'from "<pkg>"'`，还要 `grep` 框架的虚拟模块名（`nitro/`、`next/`、`virtual:`、`\0` 前缀）和配置文件（`nitro.config.*`、`vite.config.*`、插件目录）。
  2. 判断"真的没人用"要看 CI 的构建 job 是否绿，不看 grep。本机按 AGENTS.md 不能 build，所以这类改动的唯一门禁就是 CI——推之前明确写下"这一项本机无法验证"。
  3. 同类：`vaul`（Radix Drawer 的封装，可能被 ui 组件按需引用）、`file-type`（可能被运行时动态 import）。删之前先 `git log -S` 看引入原因。

## 2026-11-19 改了 action 的导出，就要同步改所有 mock

- 现象：给 `app/actions/link-preview.ts` 新增 `getLinkPreviews` 后，`components/workspace/agent-citations.tsx` 具名导入它；但 `group-chat-view.test.tsx` 和 `read-retry-toasts.test.tsx` 里的 `mock.module` 只导出了 `getLinkPreview`，于是 6 个 `test:groups` 用例全部 `SyntaxError: does not provide an export named 'getLinkPreviews'`。
- 根因：`mock.module` 是**整体替换**模块导出表，不是增量打补丁；给真实模块加导出，所有 mock 都必须跟着加。
- 规则：
  1. 给 `app/actions/*` 加导出的同一次改动里，跑 `grep -rn "app/actions/<name>" --include='*.test.ts*'`，把每个 mock 都补齐。
  2. 改完至少跑一次包含这些测试的**完整 suite**（这里是 `pnpm test:groups`），而不是只跑自己新加的文件。

## 2026-11-19 生成产物必须跟着源码一起提交

- 现象：改了 `app/v1/runs/[runId]/captures/[captureId]/route.ts`，`apps/api/generated/routes.{json,ts}` 里该路由的 `sourceHash` 过期，CI 的 governance acceptance 报 `API_DEV_ROUTES_STALE`。
- 规则：改 `app/api/**` 或 `app/v1/**` 下的 route 文件后，必须跑 `node apps/api/scripts/generate-routes.mjs` 并提交产物；`--check` 是本地可跑的（不违反 AGENTS.md 的 build 禁令）。

## 2026-11-19 新增后端文件要声明 self-hosted 依赖

- 现象：`scripts/ci/self-hosted-requirements.mjs` 要求每个**改动的**后端文件在 `config/self-hosted-requirements.json` 里声明 `mode` / `environment` / `behavior` / `test`（测试文件必须存在且在某个 suite 里）。漏了 4 个文件，`image` job 直接红。
- 规则：改 `lib/**`、`app/{api,v1,actions}/**`、`apps/{api,eve}/**`、`workflows/**` 下任何文件后，本地先跑 `node scripts/ci/self-hosted-requirements.mjs`（这个不需要 build，可以本机跑）。

## 2026-11-19 给模块加导出，要连 fixtures/ 和 scripts/ 一起查

- 现象：把 `requireUser` 挪进 `lib/acting-user.ts` 后，`tests/fixtures/legacy-scope-runtime.mjs` 用 `registerHooks` 整体替换该模块，只导出了 `currentUser`/`actAs`。`lib/workspace-access.ts` 的新 import 链接失败，两个 `test:scope-policy` 用例报 `does not provide an export named 'requireUser'`。
- 根因：第一次只 grep 了 `*.test.ts*` 里的 `mock.module`，漏了 `tests/fixtures/*.mjs` 的 `registerHooks` 文件级替换（这是本仓库第二种 mock 机制）。
- 规则：
  1. 给任何被 mock 的模块加导出后，搜索范围必须包含：`*.test.ts`、`*.test.tsx`、`*.test.mjs`、`tests/fixtures/*.mjs`、`scripts/**/*.mjs`。
  2. 本仓库有两套 mock 机制：`mock.module()`（node:test）和 `registerHooks` + `resolve/load`（fixture 预加载）。后者用 `--import ./tests/fixtures/xxx.mjs` 挂上，grep 关键字是 `resolve(`/`load(` 里的文件路径。
  3. fixture 里替换成"抛错"的模块（如 scope-store 的 acting-user）是有意的语义，补导出时要保持同样的抛错行为，不要图省事写成成功返回。

## 2026-11-19 断环前先确认真的有静态环

- 现象：我为了"断开 `workspace-access ↔ issue-access` 循环"，把 `workspace-access.ts` 的 `requireUser` 改成直接从 `lib/acting-user` 导入。结果 `workspace-access` 静态拉入 `lib/session.ts` → `next/headers`，打红了两个**故意 stub `next/headers`** 的测试（`lib/linear-sync/kill-switch.test.ts` 只 mock 了 `cookies`；`lib/personal-mailbox-producer.test.ts` 因此在测试结束后才初始化 Better Auth）。
- 根因：原代码根本没有静态环——`issue-access → workspace-access` 是 `await import()`，动态 import 不构成 ESM 静态循环。我"断环"的前提是错的，改动纯属多余且有害。
- 规则：
  1. 断环前用 `grep -n "import" <两个文件>` 确认两边的边是**静态** `import` 还是 `await import()`。动态的那条不算环。
  2. `lib/acting-user.ts` 静态依赖 `lib/session.ts` → `next/headers`。任何"只在特定路径下才需要 session"的模块（workspace-access、issue-access、各种只读 store）都应保持惰性引入，不要为了统一而改成静态 import。
  3. 判断某模块是否引入 session 链：`grep -n "^import" lib/acting-user.ts` 看有没有 `lib/session`。有，就说明静态引入它会拉 session。
