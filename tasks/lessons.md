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

## 2026-11-19 跨层追踪：组件名 grep 会漏掉同文件导出的 hook

- 现象：审计 public 层时判定 `LinearSettings` / `TelegramSettings` 是「孤儿组件」（全仓库无 import）。实际 hosted 层 `.hosted-ui/components/mikka/app-page.tsx:16,20` 用的是同文件导出的 `useLinearPlugin` / `useTelegramPlugin`，功能完全正常。
- 根因：`grep -rn "LinearSettings"` 只搜组件名，且我习惯性排除了源文件自身（`grep -v "linear-settings.tsx"`），于是 hook 导出和同文件引用全被滤掉。
- 规则：
  1. 判定「组件是否被挂载」必须同时搜**组件名和同文件的 hook 导出**，且**不要排除源文件自身**——源文件里的 `export function useX` 是跨层契约的一部分。
  2. slot 架构下，「public 层是 stub」不等于缺陷。`components/slots/settings-connections.tsx` 抛 `UI_SLOT_REQUIRES_OFFICIAL_CLIENT` 是设计，不是缺失；判缺陷前先确认 hosted 层是否实现了它。
  3. 每个 `missing-affordance` 结论至少用两条独立检索路径验证（按名字、按导入、按调用点），单次 grep 的空结果不足以定性。

## 2026-11-19 后端返回了字段 ≠ UI 使用了字段

- 现象：记忆页「待确认」功能完全不可用。后端 `lib/profile/store.ts:94` 每条新事实都写 `reviewStatus: 'pending'`，`lib/profile/memory.ts:155` 也把它放在 `pending` 数组返回，但 `hooks/settings/use-memory-settings.ts` 只解构 `facts`，`pending` 从未进入渲染，`reviewFact` 零调用者。结果：用户永远看不到 Mikka 记住了什么，记忆永不生效，且无任何报错。
- 根因：审查时看到「后端返回了 pending」就以为功能存在。实际上消费端漏了一个字段，而周围代码（`undoable` 已被 hosted 使用）看起来都很完整，掩盖了这个缺口。
- 规则：
  1. 判定「功能是否可用」必须走完 `后端返回 → hook 解构 → 组件渲染 → 用户可操作` 四步，任何一步断开都是缺陷。
  2. 看到 `data.xxx` 被返回时，`grep` 一次 `xxx` 在 hook 和组件里的出现位置；只出现在服务端和类型定义里，就是死字段。
  3. 静默失效最危险：没有报错、没有空状态提示、测试全绿。给这类修复补的测试必须做**变异验证**（删掉实现看测试是否变红），否则不知道测试在测什么。

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

## 2026-11-19 DB 测试在本机过、CI 并发下被 cancelledByParent

- 现象：`lib/captures/store.db.test.ts` 本地单跑 3.7 秒通过；CI 的 DB runner 并发 4 个 suite 时跑了 32 秒，报 `cancelledByParent` + `Promise resolution is still pending but the event loop has already resolved`，连带把同一文件里后面的 cloud-computer 子测试也掐掉。
- 根因：我在测试里加了 12 次额外数据库往返（建 user → 建 run → saveCapture → createShare → 删 user → 查 → 再插 user → 查 → 插 guard → 查 → 删 guard → 查 → 删 run → 删 user）。`saveCapture` 本身还要开 `withAccountWrite` 事务、写 activity、读回。共享 PG 连接池时这些被放大。
- 规则：
  1. DB 测试里模拟"账号消失"这类状态，优先**直接 INSERT/UPDATE 目标行**，不要走完整业务函数（`saveCapture` 的开销是直接 INSERT 的好几倍）。
  2. 断言的顺序按规则的读法排：先"存在时能用"，再"删除请求关闭"，再"行没了关闭"。不要为了复用一个 token 而反复插入/删除。
  3. 本机复现 CI 的 DB 测试：需要名为 `mikka_e2e` 的库（测试硬编码这个名字），`MIGRATE=1` 先跑 `scripts/migrate.mjs`，然后 `REQUIRE_DB=1` + 四个 URL 环境变量都指向它。
  4. `run_captures` 有 CHECK `run_captures_ready_file`：`status='ready'` 时 `storageKey`、`size`、`sha256` 都必须非空，直接 INSERT 时要一起给。

## 2026-11-19 收紧读口的过滤条件，必须同步改 fixture 的造数路径

- 现象：给 `lib/profile/store.ts` 的 `profilePromptSection` 加了 `reviewStatus = 'approved'`（修复真实的安全缺口：设置页承诺"确认后才用于回答"，而 prompt 一直在读 pending 事实）。CI 红了 `test:user-facts-db` 里唯一一条仓库作用域用例 —— 它的 fixture 用 `recordFacts` 造数据，而 `recordFacts` 按设计写 `pending`，于是整个 prompt 段读成空串，`assert.match` 报 `actual: ''`。
- 根因：过滤条件是**读口**改的，测试的**写口**（`recordFacts` → `pending`）没变。测试的名字讲的是"仓库作用域"，容易被误判成"这条断言过期了、改断言就行"，实际上应该补全 fixture 的**前置状态**。
- 规则：
  1. 给读函数加状态过滤后，第一件事是 `grep -rn "<读函数名>" --include='*.test.*'`，逐个看每个测试的造数走的是哪条写路径、写到什么状态。
  2. 补前置状态用该状态的生产入口（这里是"审批"）；测试层拿不到业务入口时，在 fixture 里直接 `UPDATE` 该列，并在注释里写明这是 fixture 前置状态而非被测行为。
  3. 顺手把新加的过滤条件本身变成断言（"还没审批时读出来必须是空"），否则这次修复没有任何回归保护。
  4. 一个 DB suite 红会连带把 `Database checks (4/4)` 两个矩阵变体和聚合门 `Production build and browser interactions` 一起拖红。判断"到底红了几件事"，看日志里的 `test:<name> lifecycle] exit code=1` 有几条，不要按 job 数。

## 2026-11-19 在 JSDoc 和它描述的函数之间插入新符号，等于把文档送给了新符号

- 现象：修 `lib/run-recovery.ts` 的静默失败时，我把新的 `swept` 辅助函数直接插在 `recoverRuns` 的 JSDoc 结束处和 `recoverRuns` 之间。结果那段"Everything run recovery does …"的文档挂到了 `swept` 上，`recoverRuns` 变成无文档；`tsc`、lint、CI 全绿，只有 review 能看出来。
- 根因：JSDoc 的归属由**相邻性**决定，不是由内容决定。插入点选在 `*/` 之后、函数之前，就破坏了归属。
- 规则：
  1. 在任何 `/** … */` 和它下面的 `export function` 之间不要插入任何东西 —— 包括注释块、常量、辅助函数。新辅助函数放到该 `*/` 之前（如果它服务于同一个导出）或放到该函数之后。
  2. 改完用 `sed -n '<起点>,<终点>p' <file>` 肉眼看一遍：每个 `/**` 的正下方应该紧跟它描述的那个声明。
  3. 这类问题 CI 抓不到，只有代码审查或人眼能抓 —— 属于"必须 review"的那一类，别指望门禁兜底。

## 2026-11-19 `test:web-auth-db` 是 flake，不要当回归查

- 现象：`tests/web-auth-handoff.db.test.ts` 的 `remote Web Workspace selection survives bearer-only HTTP and never broadens a tenant or PAT`（单条约 7 秒的重 HTTP+PG 用例）会间歇失败。本会话里出现三次：CI 报 `fetch failed` + 120s 超时；本地同样环境跑出 20/21；紧接着同参数重跑 29/29 全过。
- 判断依据：**同输入重跑即绿** + 失败信息是网络层（`fetch failed`）而非断言不一致。本机复跑要带 `BETTER_AUTH_URL`，否则 `context.baseURL` 为空，`new URL('')` 会让 4 条用例报 `TypeError: Invalid URL` —— 那是环境缺失，不是代码问题。
- 规则：
  1. 看到这个 suite 红，先原地重跑一次再决定是否调查；不要顺着 workspace/PAT 的代码路径去改。
  2. 本机跑 DB suite 必须按脚本原样调用（`bash -c "$(node -e "console.log(require('./package.json').scripts['<name>'])" )"`），漏掉 `--experimental-test-module-mocks` 或 `--import ./scripts/server-test.mjs` 会自己造出假失败。
  3. 本地补齐的环境变量：`E2E_DATABASE_URL` / `MIKKA_DATABASE_URL` / `DATABASE_URL` / `WORKSPACE_DATABASE_URL` / `ORVILO_DATABASE_URL` 指向 `mikka_e2e`，外加 `BETTER_AUTH_URL` 和 `REQUIRE_DB=1`。

## 2026-11-19 新接进 CI 的测试，"接上"不等于"跑过"

- 现象：计划 006 把六个没被任何 CI 任务执行的 suite 接进了 `scripts/ci/tasks.json`。其中 `test:factory-query-http` 和 `test:factory-monitor-http` 少了全仓库其它 factory suite 都带的 `--import ./tests/support/server-only.mjs`，CI 一真正选中就报 `ERR_MODULE_NOT_FOUND: Cannot find package 'server-only' imported from lib/task-status-run-start.ts`。在 main 上它一直是绿的，因为 main 的 `Core unit checks` 日志里**这两个测试一次都没出现过** —— 任务按改动文件被选中，很久没匹配到相关改动。
- 根因：这两个探测用例用 `FACTORY_QUERY_LOCAL_HTTP=1` 做 skip 守卫，本地默认跳过，跳过发生在运行测试体之前，所以本地永远走不到那条动态 import 链；`server-only` 本地甚至没装（Next 自己解析）。
- 规则：
  1. 把测试接进 CI 时，除了确认"文件在任务列表里"，还要确认**它在 CI 里真的被执行过**：翻一次该 job 的日志，grep 测试文件名，出现 0 次就是还没验证。
  2. 新接的 suite 要照抄同目录其它 suite 的 `--import` 前缀，不要只写 `node --import tsx --test`。
  3. 带 skip 守卫的集成测试，本地绿灯不构成证据 —— 只能靠 CI 或手动打开守卫跑。

## 2026-11-19 解决冲突时整取一方，会静默吃掉另一方的同文件新增

- 现象：`messages/en.json` / `zh-CN.json` 在合 main 时冲突，我用 `git checkout --theirs` 整取 main 版，然后只补回了自己记得的 `githubClearSearch`。结果本分支加的 `Automations.editor.devicesError` 和 `Settings.tokens.copyFailed` 被静默删掉，CI 的 `pnpm typecheck` 报两条 `TS2345`（消息键不在类型里）。`Source checks` 和 `site-search` 两个 job 报的是同一个错。
- 根因：冲突解决只按"我记住的那几个键"做人工并集，没有把两侧的键集**算出来**比对。`check-i18n.mjs` 抓不到：它校验 en/zh 之间是否成对、占位符是否一致，不校验"代码里引用的键是否存在"——那是 typecheck 的职责。
- 规则：
  1. `messages/*.json` 冲突不要 `checkout --theirs` 了事。解决后用脚本算并集：
     `flat(branch) | flat(main)` 与当前文件比对，必须 **missing 为空且 extra 为空**。
  2. 任何"整取一方"的冲突解决，都要再 diff 一次该文件的**另一侧独有内容**（`git diff <theirs> <branch> -- <file>`），而不是回忆自己改过什么。
  3. 大文件 JSON 插入键时，插在最后一个成员之前要给原最后一行补逗号；写完立刻 `json.loads` 校验再落盘。

## 2026-11-19 iOS/Web UI 的 className 不能透传，颜色查找表要放在 `lib/`

- 现象：写 `Mark({shape, tone, className})` 并把 `className` 透传给 `<svg>`，`node scripts/lint-ui.mjs` 报 `style/static-layout-only`（`className` 必须可静态检查）。同时 `className={cn(...)}` 里如果用的是**本文件内**的查找表 `MARK_TONE_CLASS[tone]` 也会报同一条。
- 根因：`scripts/ui-policy.mjs` 的 `resolve()` 只认字面量、`cn()` 实参、三元表达式、`&&` 右侧，以及**从别的模块 import 进来的对象**的下标访问（`imports.has(...)`）。函数参数里的解构 `className` 不是 `ts.VariableDeclaration`，`binding()` 找不到 → `known: false`。
- 规则：
  1. 业务组件不要收 `className` 再往下传（本体 `git grep 'className={className}' components/workspace` 里没有先例，这是原因）。要换尺寸就开 `size` prop，用字面量三元；要换颜色就开语义枚举 prop。
  2. 需要"名字 → token class"的查找表，放到 `lib/`（如 `lib/status-appearance.ts`）再 import，本文件里写表会被判不可静态检查。
  3. 加新 UI 前先跑一遍 `node scripts/lint-ui.mjs`，比写完再回来拆便宜。

## 2026-11-19 UI 变更必须先做视觉对比，没问题才准提交

- 用户原话：「凡是涉及到 UI 变更的，你必须都要进行 UI 对齐，需要从视觉上进行对比，没问题才准提交」。
- 现象：我把「lint 通过 + 单测通过 + 入口能点」当成了对齐完成。被问「你有从视觉角度去检查过吗」时，答案是**没有**。并排一比，详情页属性行 Capy 9 行我们 5 行、新建任务 chips Capy 6 个我们 3 个、issue 详情我们是整页 Capy 是右侧面板——这些 lint 和单测全都发现不了。
- 规则：
  1. UI 改动的完成标准是**并排截图对比**：我们的界面 vs Capy 对应界面，两张图一起看。
  2. 提交前必须有视觉证据：`agent-browser --session <s> screenshot` 存图并**实际 Read 这张图**，不能只跑 `eval` 查 DOM。DOM 里有 `data-mark` 不代表看起来对。
  3. 差异要分类说清：真缺口 / 故意不画（没数据）/ 结构差异（详情页是面板还是整页）。不要笼统说「对齐了」。
  4. dev server 和 Capy 登录态都在时，直接用它做对照，不要靠回忆和推测。
  5. 造数据用于对照时，用本地 dev 账号在 UI 里真建一条，比读代码想象行样式可靠。

## 2026-11-19 改 UI 前先用 DOM 确认是哪个组件在渲染

- 现象：给 `components/workspace/issue-list.tsx` 加了 ⌘+点击开右侧面板。改完 typecheck 通过、代码确实在文件里、dev server 也重启了，但实测点击仍然整页跳转（URL 还是 `?issue=`）。查 DOM 祖先链才发现列表行是 `DIV.ui-kb-row → SECTION.ui-kb-group → DIV.ui-kb`，渲染它的是 overlay 的 `.hosted-ui/components/kanban.tsx`，`issue-list.tsx` 在那条路径上**根本没被渲染**。
- 根因：同一个界面有两套实现（公开仓库的开源 UI + 私有 overlay）。凭文件名猜会改错地方，而 typecheck / lint / 单测**全都发现不了**——它们只证明代码能编译。
- 规则：
  1. 改 UI 前先 `agent-browser eval` 看目标元素的 tag + class + 祖先链，确认是哪个文件渲染的。已知标记：`ui-kb-*` = overlay `kanban.tsx`；`data-mark` = `lib/state-mark.ts` 的注册表；`data-focus-id` 在**两个**文件里都有（`kanban-board.tsx` 和 `issue-list.tsx`），不能只凭它判断。
  2. 改完必须真的点一次，看 URL / DOM 有没有按预期变化。typecheck 通过 ≠ 渲染路径对。
  3. 另一个坑：Base UI 的 `Button` 不会把原生事件交给你的 `onClick`，在它上面读 `event.metaKey` 永远读到 false。要么用捕获阶段（`onClickCapture`），要么改在普通元素上。

## 2026-11-19 别用 git checkout 撤自己的一处改动

- 现象：想撤销一次把 `messages/*.json` 整文件重排的 python 操作，用了
  `git checkout messages/en.json messages/zh-CN.json`。这两个文件里有 **6 个 agent 未提交的
  i18n 改动**，一起被回退掉了，包括自动化页 26 个 key —— 页面整片显示成 key 本身。
- 恢复：`~/.claude/projects/<proj>/<session>/subagents/agent-*.jsonl` 存着每个 agent 的
  Edit 调用，逐条提取 `old_string`/`new_string` 就能重放。22 条唯一编辑，重放 18 条。
- 规则：
  1. 只想撤自己那处，就用精确 Edit 反向替换；`git checkout <file>` 是**文件级**回退，
     会把别人未提交的东西一起带走。
  2. 用 Python 改 JSON 时不要 `json.dump` 整个文件 —— 键序、缩进、数组换行都会变，
     diff 从 6 行膨胀到 131 行。用精确字符串替换。
  3. 判断「该不该补回某个 key」看**代码还引用吗**，不是看「跟 HEAD 比少了什么」。
     `PullDirectory.states.failed` 被删是重构（`PullState` 只剩 7 个值），补回去等于塞回死 key。
  4. 验证 i18n 完整性最可靠的办法是让应用自己报：把所有页面打开，抓
     `MISSING_MESSAGE` / `Could not resolve`，比静态扫 key 准。

## 2026-11-19 dev server 只能有一个，第二个会把第一个挤死

- 现象：后台又起了一个 dev server 做验证，之后服务出现
  `ENOENT: rename '.../steps.mjs.api-aliases' -> '.../steps.mjs'` 然后退出。
  但端口还返回 200 —— 主进程变僵尸：页面能出，`api` 全 404，eve 端口无响应，
  界面显示「无法连接 Mikka」。
- 根因：两个 dev server 共用 `.cache/dev-runtime/3100/`，互相 rename 对方刚写的临时文件。
- 规则：
  1. 起之前先 `lsof -nP -iTCP:3100 -sTCP:LISTEN`。已经有一个就别再起。
  2. 崩过一次之后先 `rm -rf .cache/dev-runtime/3100` 再起，残留会让下一次继续失败。
  3. 健康检查用 `curl http://localhost:3100/mikka/api/version`——**带 base path**。
     不带的话 404 是正常路由，会被误判成服务挂了。
  4. 端口 200 不等于服务健康。要同时看 `api` 和 eve 端口。

## 2026-11-19 agent-browser 的 `media` 是 `set media` 的子命令

- 现象：`tasks/alignment-shot.sh` 里写的是 `agent-browser ... media light`，实际返回
  `Unknown command: media`，退出码又被 `>/dev/null 2>&1` 吞掉。结果**之前所有「亮色」截图
  全是暗色**，等于从来没验过亮色。
- 规则：
  1. 正确形式是 `agent-browser --session <s> set media light|dark`（在 `set` 分组下）。
  2. 必须**先设 scheme 再 open**：页面加载时才按 `prefers-color-scheme` 求值；
     先 open 之后 `html.dark` 已经加上，再设也不会重算。
  3. 截图脚本里不要静默吞掉退出码。`&& echo ✓ || echo ✗` 至少留个痕迹。

## 2026-11-19 Capy 登录态靠固定 profile，不靠导 cookie

- 三层原因，逐个排除过：
  1. agent-browser 默认用 `/var/folders/.../T/agent-browser-chrome-<uuid>` 做 Chrome profile，
     浏览器一关就被系统清理，登录态必丢。
  2. `agent-browser auth save` 只存「用户名+密码+表单选择器」，Capy 走邮箱 OTP，没有密码字段。
  3. 导 cookie 也不行：Clerk 的 `__session` 是 **60 秒寿命 JWT**（实测 `iat`/`exp` 差 60），
     导出那一刻就开始作废；它能长期保持登录靠的是 `__client`（长效），而临时 profile 从没写下来。
- 复制 Brave profile 也走不通：macOS 上 Chromium 的 cookie 密钥在 Keychain、不在 profile 文件里。
  实测把 Brave 的 `Cookies` + `Local State` 复制给 Chrome，13 条 capy cookie 被当成无效清成 0 条；
  用 `--executable-path` 指到 Brave 内核结果一样。
- 正确做法：`--profile "$HOME/.cache/mikka-capy-profile"` 固定目录，让 Chrome 自己维护
  `Default/Network/Cookies`（落盘 12 条，含 `__client`）。**关闭重开验证过**仍在 `/new`。
- 判断是否登录不能看 `document.cookie`（`__session` 是 httpOnly，JS 读不到），要看
  `location.pathname` 有没有被重定向到 `/sign-in`。

## 2026-11-19 CSS 模板字符串里的反引号会白屏整个应用

- 现象：给 `kanban.tsx` 的 Match 行加样式注释时，写成
  ``/* ... a quiet chip per condition, `property is value`, with its own ✕ */``，
  结果**整个应用白屏**——不是 Match 行不显示，是所有页面都不渲染。Vite 报
  `[plugin:vite:oxc] Transform failed` / `[PARSE_ERROR] ... kanban.tsx:1446:76`。
- 根因：这整段 CSS 是 `const css = /* css */ \`...\``，一个 JS 模板字符串。
  注释里的反引号**提前结束**了模板字符串，后面全被当非法 JS 解析。
  我以为「反引号在注释里」是安全的——在 CSS 注释里安全，在**模板字符串**里不安全。
- 规则：
  1. 往这种 CSS-in-template-string 里写任何东西，**注释也算**：不能有反引号、不能有 `${`。
     要引用代码单词就用普通单引号：`'property is value'`。
  2. 改完这类文件立刻验白屏，别等截图：
     `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/mikka/api/version`
     （必须带 base path），再
     `agent-browser --session mikka eval "document.body.innerText.includes('PARSE_ERROR')"` → `false`。
     白屏时页面上是红底报错面板，不是纯空白，很容易看出来。
  3. 看到报错面板先修语法，**绝不能把那帧截图当视觉证据**。
  4. 这类改动静态检查抓不到（`.hosted-ui` 不在公开仓 tsconfig 的 include 里），
     语法错误只有 dev server / 浏览器会告诉你。

## 2026-11-20 提交 merge 时漏了 `git add`，把带语法错误的 commit 推了上去

- 现象：解决完 13 个 merge 冲突、跑完 typecheck 和 lint、又修好 5 个让合并结果能编译的文件，
  然后 `git commit`——但**这 5 个文件没有 `git add`**。推上去的 merge commit 里
  `apps/api/scripts/dev.mjs` 还留着 `words.split('` 加一个真实换行，文件根本无法解析。
- 根因：`git commit` 只提交**暂存区**。lint 和 typecheck 看的是**工作区**，两者不一致时
  检查全绿、提交却是坏的。我脑子里想的是「冲突都标完了」，忘了新修的文件也要进暂存区。
- 规则：
  1. 修完就 `git add`，不要攒到最后。
  2. commit 之后、push 之前，抽查一个刚修过的地方确认它在 HEAD 里：
     `git show HEAD:<path>` 再看那一行。这次是 push 之后才发现，只能补一个 fix commit。
  3. 已经 push 的错误 commit 不要 amend 加 force push，补一个 fix commit。

## 2026-11-20 改 `allowBuilds` 会改变构建行为，不只是消掉 pnpm 的报错

- 现象：`pnpm-workspace.yaml` 里 11 个包的 `allowBuilds` 值是 pnpm 自己的提示文本
  `set this to true or false`，每次 `pnpm install` 都以 `ERR_PNPM_IGNORED_BUILDS` 失败。
  我把其中 4 个改成 `true`（理由是「它们需要 native 绑定」），install 过了，
  但 CI 上 7 个 check 全挂：`UNLOADABLE_DEPENDENCY: Could not load .../zstd.node`。
- 根因：那个字符串在 pnpm 眼里**不是 true，等于不跑构建脚本**。设成 `true` 之后
  `@mongodb-js/zstd` 真的编译出 `zstd.node`，Eve 的 rolldown bundler 去读它、
  发现是二进制就报 `stream did not contain valid UTF-8`。
- 规则：
  1. 修「值非法导致失败」的配置，先弄清旧值实际生效为什么。一个从未被解析成 true 的值，
     实际语义就是 false；改成 true 是功能变更，不是修复。
  2. 只想消掉 `ERR_PNPM_IGNORED_BUILDS` 而不改变构建行为，就全部显式写 `false`。
  3. 验证要复现 CI 条件：删掉已编译的 `.node` 再跑 `node scripts/build-eve.mjs`，
     而不是只看 `pnpm install` 绿了。

## 2026-11-20 审计出清单后不要问「先做哪个」，用户要的是全部做完

- 现象：SEO 审计给出 6 条 Critical、10 条 High，我按批次排好优先级，然后问用户
  「三个可选下一步你挑一个」。用户回：「你直接把题做完就行了，你不用问我哪个先做，
  哪个后做，都要做」。
- 根因：把「优先级排序」当成了交付物，实际上排序只是内部执行顺序。用户要的是结果，
  不是选择题。而且我把本该自己判断的事（哪些能自动做、哪些只能人手做）抛回给了用户。
- 规则：
  1. 列出清单后直接按依赖顺序执行，不要用「你挑一个」收尾。
  2. 只有两种情况值得停下来问：需要用户做业务决策（定价、是否开源、是否接受不可逆操作），
     或者需要用户提供我拿不到的东西（仓库位置、后台权限）。
  3. 停下来时要把「我已经做到哪、剩下这一步为什么只能你做」写清楚，而不是给选项。

## 2026-11-20 用响应头推断「页面没被缓存、每请求重渲染」是错的

- 现象：SEO 性能审计看到 `x-nextjs-cache: MISS`、`cache-control: max-age=0, must-revalidate`，
  判定「HTML 不走 CDN 缓存」，据此建议加 Cache Rule / 加 `revalidate`。
  实际跑 `pnpm build` 后路由表显示 `/mikka` 等页面全是 ○ Static（构建时预渲染），
  docs 是 ● SSG。那些头是 OpenNext 外层的响应策略，不是重新渲染的证据。
- 根因：把外网可见的响应头当成渲染方式的证据。响应头能证明「浏览器/边缘怎么缓存」，
  不能证明「服务端有没有重新渲染」。而如果真按这个判断加了 Cache Rule 覆盖
  `must-revalidate`，发布瞬间会拿旧 HTML 拼新 chunk，直接白屏。
- 规则：
  1. 判断「是不是静态化」要看构建路由表（`○`/`●`/`ƒ`），不要从响应头反推。
  2. 建议改缓存策略之前，先确认页面本来是不是预渲染的；已经静态的页面「加 revalidate」
     是无效动作。
  3. 覆盖 `must-revalidate` 属于危险改动，会破坏部署原子性，默认不做。

## 2026-11-20 robots.txt 里的「放行」和边缘的「放行」是两件事

- 现象：技术审计读 robots.txt 得出「PerplexityBot 放行」（文件里确实没有它），
  而实测同一 UA 拿到 403 `Your request was blocked.`。反过来，`Google-Extended`
  在 robots 里是 `Disallow: /`，但边缘返回 200 —— 两者都不矛盾，因为是两层。
- 根因：Cloudflare 的 AI 爬虫控制同时改 robots.txt 托管块**和**边缘执行，
  但 PerplexityBot 只被边缘拦（它不在托管列表里），Google-Extended 只被 robots 拦
  （它本来就不自抓页）。
- 规则：
  1. 判断 AI 爬虫能否访问，必须**实跑 UA**：`curl -A "<完整官方 UA>" -o /dev/null -w "%{http_code}"`。
     读 robots.txt 只能得出「声明层」结论。
  2. 报结论时分开写「robots 层」和「边缘层」，不要合并成一句「已拦/已放行」。
  3. 拦 AI 爬虫要区分训练 UA 和检索 UA：OpenAI（GPTBot / OAI-SearchBot）、
     Anthropic（ClaudeBot / Claude-SearchBot / Claude-User）都有两套，拦前者无损；
     **Perplexity 只有一个索引爬虫 PerplexityBot**，拦掉等于退出它的检索面。

## 2026-11-19 设计稿里的引用 / chip 不能凭印象画
- 错误：inline chip 画成灰底药丸，把 Claude Code 当成可 @ 的对象，还编了一个 Skill chip（snapshot-update）。用户连续纠正三次。
- 根因：没先读 Capy 源码就动手；也没核对 Mikka 的名词——Bot 是用户建的派发者，Claude Code / Codex 是 Agent（见 messages/en.json "agentRequired"）。
- 规则：
  1. 画任何对标 Capy 的控件前，先在 /Applications/Capy.app/Contents/Resources/renderer/assets 里找到对应组件（按 data-track-owner 路径搜），读清类型、样式 class、交互，再画。
  2. 例句里只出现 Mikka 真实存在的对象：文件 / 任务 / PR / thread / Bot。Agent 不可提及。
  3. 新增的状态不要放在会被相邻 section 盖住的位置；画完截整节确认可见。

## 2026-11-20 模型调用只许走 LiteLLM；对用户的选项也要用中文

- 规则（Alex）：LiteLLM 建好之后，所有模型调用都必须经后台的 LiteLLM，任何绕开它的方式都不允许。换模型时不要在代码里写死模型 ID，也不要直连 Vercel AI Gateway 或厂商，哪怕仓库里已经有同样写死的先例（`WRITE_PLANNING_MODEL`）。先例不等于合规，要先查规则。迁移由 alexj11324/Mikka#2869 跟进。
- 用户说"走 Vercel 网关"时，先确认这条路是不是经过 LiteLLM，再动手；不确定就先问，不要按字面直连。
- AskUserQuestion 的问题和选项也算"对话"，必须用简体中文。

## 2026-11-19 · Figma 对照稿
- 画 Mikka 设计稿前，先去「Mikka 三栏布局草图 v0」（zPe5LKycb2XuT1ivCLRw07）找现有约定和已接入的 shadcn 库，不要新建文件、自建组件。`get_libraries` 显示为空不代表没有库：直接 `search_design_system` 搜 "Button - Nova"，就能命中 Obra shadcn/ui kit 与 ReUI shadcn。
- 抓竞品页面只用内置浏览器，不要切到 chrome-devtools 或别的浏览器。内置浏览器截图的分辨率受面板宽度限制，要高清图就请用户把面板拉宽，不要往页面里注入外部脚本。

## 2026-11-19 · Figma 对照稿要画交互，并以 main 的实际界面为准
- 用户纠正：只画了一张静态页面，没画右键菜单、筛选、显示设置、状态选择器、新建弹窗等交互状态；sidebar 入口也还是旧稿。
- 规则：对照 Capy 画任何页面时，先在内置浏览器里把这一页的每个弹出层点一遍、截图（右键、⋯、筛选、显示、新建、二级菜单），再一页一页画 Mikka 版。
- 规则：画之前先读 main 上的实际实现。侧栏的真实实现在私有层 `.hosted-ui`（capy-sidebar / app-frame），公开仓库的 `components/app-sidebar.tsx` 和 `nav-main.tsx` 已是死代码。文案取 `messages/en.json`。
- 规则：Figma 里用 `resize()` 改过尺寸的 auto-layout 容器，主轴会被锁成 FIXED，要再设 `primaryAxisSizingMode="AUTO"`，否则内容会被裁掉。
