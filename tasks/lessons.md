# 教训记录

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
3. 浏览器验收时顺手扫 `\b(Namespace)\.[a-z0-9_.-]+`，这是发现缺 key 最快的手段。
4. 动态拼接的 key（slash items、枚举）要么列白名单，要么在浏览器里逐项点开确认。

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
