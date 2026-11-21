# Issue #1415 功能发布验收

**固定生产版本的完整功能验收已通过。** 2026-11-07 01:28:30 UTC，[生产 run 42323706132](https://github.com/alexj11324/Mikka/actions/runs/42323706132) 完成浏览器、Coordinator 与到期提醒、mobile/源码 daemon、OAuth/MCP 四段验证；六份原始 JSON 的目标身份、团队、清理结果及最后现场核验一致。验收使用共享 SMOKE 账号，在 **Acme Inc.** 工作区执行。正常桌面 [desktop-2026.10000.504](https://github.com/alexj11324/Mikka/releases/tag/desktop-2026.10000.504) 已满足本 Issue 的一次性正式发布要求。

本文记录已经发生的产品、部署和验收事实。本文所属文档 PR 的 CI、合并、随后正常 main Web 发布及最后控制资源停止，另由 Owner 在 [Issue #1415](https://github.com/alexj11324/Mikka/issues/1415) 的收口评论记录；本文不提前声称这些后续动作成功。全部历史失败、取消、跳过及原始回执哈希保留在 [完整结构化证据](final-evidence.md)，没有用本轮成功改写旧结果。已验证的生产结果也见 [Owner 的结果记录](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6700400347)。

## 最终生产身份与结果

| 对象 | 实际绑定 |
| --- | --- |
| 被测应用 | `354f6833bf3361a0c796275ce5d0bc8e8e5bd413`，tree `46b3ef2e191e38025fe79a5cd2da7f74ef8e33a4` |
| 实际驱动 | `f3635e534b2de87d354e3c53c28542782588f609`，真实 main `workflow_dispatch`；相对应用只新增 AGENTS/merge-risk 文档 |
| 正常 Web 来源 | [42321398083](https://github.com/alexj11324/Mikka/actions/runs/42321398083)，attempt 1，job 128246551955，正常 main push |
| 实际生产部署 | `dpl_Dgwi56ivX78rULiiUKLQz4V5A3R9`，READY，来源 354f；生产 alias 与公开 version 均一致 |
| 生产验收 | [42323706132](https://github.com/alexj11324/Mikka/actions/runs/42323706132)，attempt 1，job 128253968952 |
| 工作区 | Acme Inc.；四段报告均为同一已验证团队 hash、active-admin 身份依据和共享账号会话 |
| 最后现场核验 | 01:28:26.611 UTC，四段通过、全部要求的清理成立、同一部署目标仍有效 |
| 原始产物 | [artifact 13553864414](https://github.com/alexj11324/Mikka/actions/runs/42323706132/artifacts/13553864414)，6 个 JSON，5,947 B；ZIP SHA256 与所有成员 CRC、字节数、SHA256 已核验 |

Web 的完整构建及迁移于 01:06:50 成功，prebuilt 上传于 01:19:28 完成，正常 workflow 的公开版本检查通过，run 于 01:19:33 终结成功。独立匿名读取在 01:21:03 得到 HTTP 200、无重定向、精确 build354f，读取前后 alias 均为 Dg。此部署包含本次人类请求与后台事件分批修复的实际 `store.ts` blob；没有仅更新验收驱动就把旧应用当成修复后应用。精确发布记录见 [Web run](https://github.com/alexj11324/Mikka/actions/runs/42321398083) 和结构化证据的 `closeoutUpdates.v16.records.normalPublication354`。

| 生产段 | 实际结果 | 清理及范围 |
| --- | --- | --- |
| 浏览器，01:23:40–01:23:52 | 正常登录、唯一可信团队选择、Coordinator 页面/面板/输入区、Computer tab 存在及所需 feature 断言通过；page errors 为 0 | 页面关闭、同 Cookie 会话正常 sign-out、匿名 get-session 复核全部通过。没有点击 Computer 启动云机器；生产截图、trace、video 均关闭 |
| Coordinator 与到期提醒，01:23:52–01:27:06 | 1 次正常用户提交；正常一次性 schedule 和提交的操作得到确认；真实 managed wait、到期 runDue 和已完成 Coordinator 均出现 | 0 次清理补交、0 SDK mutation、0 cron 请求、0 驱动 SQL 写；future schedule absent 为 true；正常 sign-out 成功 |
| mobile 与源码 daemon，01:27:06–01:28:14 | 正常 mobile home/owner、已发布动作、enrollment、credential exchange、设备注册与 owner、禁用调度、heartbeat 全部通过；真实 `HttpServerLink`、protocol 3 | 新凭据正常撤销，旧凭据拒绝，临时设备移除；原设备和原凭据完整保留；本次会话退出。**未执行 OS 安装或服务安装** |
| OAuth/MCP，01:28:14–01:28:24 | 正常 owner-managed client、PKCE S256、`mikka` scope consent、initialize、tools/list，实际目录 25 项 | access token 撤销并拒绝、client 删除并确认不存在、会话退出并确认匿名；0 tools/call、0 model 请求、无 refresh scope/token |
| 最终汇总，01:28:24–01:28:26 | 四份报告真实存在且通过，APP/driver/run/attempt/Web/deployment/team 一致，最后现场目标仍一致 | `allRequiredCleanupProven=true`、`finalTargetVerified=true`；不是仅凭 artifact 存在或 workflow 总状态推断通过 |

Managed 的实际时间链为 wait 创建 **01:24:14.939**、到期 **01:26:55.000**、wait 完成 **01:26:56.310**、runDue 创建/开始 **01:26:56.756**、完成 **01:26:57.311**。报告仍保留 `timerTerminalRequired=false` 和 `concurrentReconciliationExcluded=false`：该证据证明正常托管执行及其相关到期操作，未排除同时存在的其他 reconciliation，也不要求 timer 的整个 run 已终结。其 `sessionClosed` 依据正常 sign-out 的 HTTP 成功响应，未额外声称本段有匿名 get-session 见证。

MCP 的 `loopbackCallbackObserved=true` 指原 HTTP helper 验证了授权响应中的 callback URL 和 state，未运行 OS listener；`browserConsentUI=false`。团队绑定限于正常 owner session，`catalogueWorkspaceDataVerified=false`，25 项目录不代表逐工具调用或团队数据读写已测。生产浏览器没有生成新像素截图；以下原生/Web 像素证据继续绑定各自旧版本。

六份原始成员的校验与日志比对范围明确区分：attestation 和 managed 的完整 JSON 与 stdout 相等；mobile、MCP、aggregate 仅对日志实际打印的摘要字段逐项相等；browser 的完整报告来自原 artifact，日志没有对应完整 JSON。没有声称不同格式的 stdout 与成员原 bytes 相等。原 ZIP SHA256 为 `1de86cba44055d435a988ceda7c83408295b2059870390413eac00341a10e77e`。

## Owner 调整后的范围与原八项清单

[Owner 评论 6684028510](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6684028510)、[后续确认](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6685346808) 和 [PR 范围确认](https://github.com/alexj11324/Mikka/pull/1474#issuecomment-6685387641) 将交付改为功能验证、正常上线与正式桌面发布。**性能实测及其门槛、旧首页性能对照、一小时 idle、Dev ZIP 和隔离人工后端交付已取消。取消不等于测试通过。** 既有 polling-policy、idle-budget 等功能合同继续保留。

| 原清单 | 本次结论 |
| --- | --- |
| 桌面/网页截图、动态区域遮罩、差异不超过 0.1% | 已有固定版本实测通过：Web98、原生100组及实际截图 artifact；不扩称 APP354f 又做过原生像素测试 |
| 通知、角标、自动更新、半透明窗口与深链接保留 | 已有真实原生 smoke/lifecycle 与清理证据通过 |
| 离线启动、恢复网络 | 已有真实原生功能及清理证据通过 |
| 冷启动到可操作比 hosted 更快 | **Owner 取消性能门槛**；旧快慢和失败保留，不写 PASS，不补测 |
| 一小时空闲 DB 查询/字节对照及无轮询合同 | **一小时测量取消、未执行**；原无轮询/idle-budget 功能合同保留，不把取消项打勾为通过 |
| 凭据不入 renderer、系统浏览器登录、IPC/CSP/导航限制 | 固定版本的真实包、多进程 Keychain 与安全功能 CI 通过；本轮 MCP HTTP callback 不代替 OS 浏览器回调验收 |
| 网页截图和行为保持、网页测试通过 | 历史 Web98 比较与本轮 APP354f 正常生产浏览器分别通过 |
| 所有 CI 通过 | 原迁移 PR、必要修复各自 CI/GG 已通过；APP354f 完整 main CI 12/12 成功；最终文档 PR 仍须自身正常 CI/GG 与发布闭环 |

当前有效的生产浏览器、managed/到期提醒、mobile/源码 daemon、MCP、默认 framework/null 和一次正常桌面发布均有真实结果。最终文档正常发布与资源收尾属于后续收口动作，由 Issue 评论记录，未在本稿提前打勾。后续外部功能 PR 推进 main，不新增“每次都须再发一个桌面版本”的要求；504 已满足一次性交付。

## 普通验收团队与一次性设置

依据 [AGENTS](https://github.com/alexj11324/Mikka/blob/f3635e534b2de87d354e3c53c28542782588f609/AGENTS.md)，普通生产验收使用已有共享 SMOKE 账号，在 Alex 的团队工作区执行，不登录 Alex。最终四段各自使用独立正常会话，读取有界的团队候选，按可信 active-admin 身份匹配，正常 `workspace.switchWorkspace` 后无 query 回读同一团队和会话。最终四报告的 team hash 均为 `fb00a1d8c63a0ae1c56ff3273bd259fd0756b8631b83e42f226926d389b3dade`；报告没有成员邮箱、成员 ID、Cookie 或 token。

[Owner 在 #1515 的单次授权](https://github.com/alexj11324/Mikka/issues/1515#issuecomment-6694934529) 允许完成所需邀请与订阅分享。第一次正常设置因两个 active-admin 团队而闭拒，未写设置；没有猜 first/name，也没有靠重新邀请刷新旧成员快照。后续将正常登录的当前 owner 身份与只读证据中的精确团队 hash 绑定，并排除 #1506 明确的独立测试 fixture，才执行必要设置。这里的 owner 是可转移的当前 owner，不是永久 creator。

[设置 run 42315105199](https://github.com/alexj11324/Mikka/actions/runs/42315105199) 于 2026-11-06 23:56:52 完成：SMOKE 正常加入既有 **Acme Inc.**，Claude 与 Codex 两个现有订阅来源可见，双方正常 sign-out 和匿名复核通过。该次自有 API key 数为 0，未执行 key 分享请求，也没有模型 prompt；不能写成实际 API key 共享调用已测，或两个订阅模型都完成过 prompt。此单次例外不扩大普通验收权限。后续验收在 Acme Inc. 中执行，见 [验收账号约定](../../acceptance.md)。

## 迁移、构建与环境问题的实际修复

共享前端由 Vite 构建，Web 与桌面继续复用业务组件；Hono/Nitro 承担 API 和 Node/Vercel 生命周期，兼容层只覆盖现有业务使用的 Next 接口。Node 和 Vercel 都由同一生产构建图生成，`pnpm build` 的最后步骤仍执行原迁移。认证、Cookie、Web/desktop RPC 的不同身份边界、参数 schema、wire codec、origin 和业务权限均保留。实际入口、命令及回退详见 [运维文档](../../operations/web-runtime.md)。

### 两次受阻的生产发布与已确认的环境根因

2026-11-06 **14:31:22 UTC**，项目 framework 从 Next.js 改为 Other/null；**14:31:31** 正常合并 #1474 到 main6f。首次 [Web42234691634](https://github.com/alexj11324/Mikka/actions/runs/42234691634) 通过编译与类型检查后，在迁移目标 URL 校验处失败，没有上传。

[PR1482](https://github.com/alexj11324/Mikka/pull/1482) 修复了一个真实 codec 缺陷：已按 JSON 字符串编码的环境值再次交给另一种 dotenv parser，会损坏有效的引号、反斜线和 CR 等字节。builder 改为直接使用原 helper 已解析、补值和校验的对象，原行格式保持。纯合成红绿及相关29/29测试通过。合成 fixture 的 GitGuardian 误报经正常精确 false-positive 处置及同 PR 的正常 reopen 扫描通过，扫描和历史均保留。

47d 的 [第二次 Web42241628628](https://github.com/alexj11324/Mikka/actions/runs/42241628628) 仍在同一 URL guard 失败，证明 codec 修复没有单独解释实际生产故障。后续 [只读结构诊断42246758230](https://github.com/alexj11324/Mikka/actions/runs/42246758230) 重放实际 Vercel65.4 pull、dotenv4 环境选择及隔离子进程的 @next/env 对照，没有运行旧 Next/main622 全应用，0 build、0 DB 连接、0迁移、0部署：

| 目标 | 文件解码后 | 原 job 来源 | 旧 CLI 选择 | 修复前 direct builder |
| --- | --- | --- | --- | --- |
| `MIKKA_DATABASE_URL` | 长度11，原 URL guard 拒绝 | 长度156，guard 接受 | 非空 job，有效 | 文件，无效 |
| `DATABASE_URL` | 长度156，guard 接受 | Infisical `prod:/vercel` 的精确条目不存在 | 文件，有效 | 文件，有效 |

[PR1487](https://github.com/alexj11324/Mikka/pull/1487) 恢复旧 CLI 的非空 job 值优先、空或缺失才回填文件的合同，保留 JSON 对象边界和生产/仓库/source/deployment pins；构建前只用原 URL helper 校验两个最终目标，不去引号、不替换 URL、不采用规范化返回值。相关32/32、实际 PR API78及3条 Analytics Chromium 路径通过，6f9 的正常完整构建和迁移随后成功。原失败目标在建连前被拒绝，不推断整个失败 build 没有其他目标的 ledger 读取。

### 生产验收入口与正常身份绑定

原自动验收的 current-main 检查与后续外部 PR 形成实际时序冲突：多次 Web 已正常发布，但自动 run 在读取业务凭据前因 main 前移或默认并发队列取消而未执行。正常恢复只重跑原 GitHub run，未改事件或 source；原来源失配时拒绝继续。已合入的 [PR1520](https://github.com/alexj11324/Mikka/pull/1520) 增加独立 main `workflow_dispatch`，显式记录真实 driver 与不可变 deployed target。

该入口在读取 SMOKE 凭据前核验真实 driver run/event/path/head/attempt、成功 Web 来源、固定项目与团队、READY deployment、生产 alias 和公开版本；每段业务前后及最终汇总再次核验同一目标。APP 不需要等于随后前移的 main，但真实 APP、driver 和事件不能伪造。原自动/普通发布门禁保留。目标漂移不能通过，正常清理仍须执行；第一次2960尝试就因旧 G68 已被同 SHA 新9df替换而在凭据前拒绝。最终354f/Dg没有发生此漂移。

新团队规则、真实 API shape、SDK 编译名称和 Coordinator UI 前提的修复均经过各自正常 PR/CI。历史只读 SDK 查询最初使用带 `.ts` 的名称得到0行；exact2960的锁定编译器证明实际 ID 无 `.ts`，修正查询后读到候选 run/events。候选查询不能证明属于旧请求，因此没有倒填旧 managed PASS。旧8180浏览器 `browser_assertions_failed` 没有具体 locator，仍保持原因未定位的原失败；[PR1575](https://github.com/alexj11324/Mikka/pull/1575) 依据真实 Coordinator selector、panel、composer 和 Computer tab 合同移除旧个人 Smoke Bot fixture 依赖，并添加闭集阶段诊断，未创建新 Bot 或放松 feature/Computer 断言。

### 人类请求与后台事件分批

旧个人工作区自动 run42280729453 实际提交1次，随后 `unexpected_tool`，原记录为 `future_schedule_unproven`。对该精确 marker 的只读核查发现，人类请求仍是独立的 `user_message`，具有正常 human session/host stamp；相邻后台 `issue_status_changed` 与它在同一轮交付。证据支持“同轮批次混合”，没有证明文本被拼接，或用户 stamp 被剥除。旧请求附近真实出现 web_search 与拒绝语句。后续针对同一 marker 的只读查询确认当前匹配 schedule、active next_at、future next_at 都为0；这解决该 marker 的当前遗留不确定性，未重写旧失败。

[PR1580](https://github.com/alexj11324/Mikka/pull/1580) 只改变实际 `takeInbox` 的分批：现有 schedule/task authority 保持；同批普通人类请求及其较新的 STOP/修正按原相对顺序一起交给原 task-isolation helper，runtime/background 留队，直接人类批次不再补背景事件。最初逐条拆开每个人类消息的草案会让 STOP 留到下一轮，已在审查中否决，未发布。最终修复不丢通知、不新增空闲唤醒、不改 scheduled task 条件，也未承诺无限人类输入下的固定后台公平性界限。

PR 的实际90项 bot-chat DB、16项 schedule、1项 task-binding，以及合并后完整 main CI 都通过；最终生产 APP354f 包含此修复，新的 managed 案例按正常一次用户提交完成。旧请求没有被重放来改写历史。本次证据不单凭“run绿”作结论，四份原报告、正常清理和最后目标检查同时成立。

## CI、原生与兼容证据的版本范围

| 证据 | 真实版本/范围 | 结论 |
| --- | --- | --- |
| 原迁移 #1474 | head b765；actual28ba7e9c/tree485f09，与迁移 merge6f 同 tree | 15 workflows + GitGuardian 成功；Mac7 smoke、100 parity、8 lifecycle、三进程两 profile Keychain、全部清理及 owner/peer baseline 通过 |
| PR1575 harness | actual924ee3/tree04def，与正常 merge74d 同 tree | 17 checks：16成功、1正常 OIDC skip；read-cache163/163含3个阶段诊断用例；不是当时生产业务 PASS |
| PR1580 runtime fix | actuala4d5e521/treea96；head413fe94 | 3 workflows 成功、17 checks 16成功/1正常 skip；API78、frontend22、迁移55、类型/lint；真实 DB90/16/1零skip |
| APP354f 完整 main | [CI42321398149](https://github.com/alexj11324/Mikka/actions/runs/42321398149)，tree46b3，包含期间正常合入的 artifact UI 变更 | 12/12 jobs 成功；4 DB shard共68 scripts均OK，受影响90/16/1再次实际执行；该 tree 不冒称等于 PR 的 treea96 |
| 历史 Web 比较 | Next3f10 对 Vite/API5715，同 harness5715 | 两主题98/98；1440×900、DPR1；最大0.0956018519%，小于原0.1%，mask几何全部一致 |
| 隔离公共 HTTPS | 7ed 的 node-server 产物与正常测试账号 | 35/35及清理通过；不冒充本轮生产域名 |
| tracing | 7ed，一次正常 owner workspace GET | 同trace的4个DB span、本地OTLP真实接收；默认0.1 sampler，预选其接受的traceID；只证该条链路，不测采样率或证明生产供应商入库 |
| Factory 五文件 | exact69e9+父级预算修正，及后续 f01/095d CI | 各305/305；单项SQL/lock/model时限未放宽；独立库、role、进程清理通过 |

“Production build and browser interactions”这个 CI job 只有结果汇总，不算额外实际 build/browser 执行。真实 Analytics3路径的 Chromium 记录与生产浏览器报告分别计数；Browser gate 也不被包装成浏览器测试。源码220条 route mapping、35项HTTPS、14项实际编译入口 Request/Response 是不同证据，未声称220条路径都经过网络调用。历史 PG wire35窗口和 tracing近似404B属性不能混算，已取消性能验收后没有恢复性能门槛。

[原生 Desktop run42231017214](https://github.com/alexj11324/Mikka/actions/runs/42231017214) 的实际环境为 macOS26.7.2、image20261102.0473.1、Node24.22.2。最大像素差异约0.0027006%。[artifact13510164029](https://github.com/alexj11324/Mikka/actions/runs/42231017214/artifacts/13510164029) 的 `parity/` 含100组 hosted/bundled/diff，共300张PNG与 `parity/parity.json`，到期时间为 **2026-11-13 14:30:32 UTC**。下载依赖正常 GitHub 权限及保留期，未承诺永久可下载。

后续原生证据也保留独立来源：#1490 actuale6f与f41仅两个build脚本不同；#1493 actualbbde与791仍差16个Coordinator文件；#1499 actual6c3f与565仅4个根文档不同，应用子树一致，最大像素差异0.000925926%；#1496 [actual84726339 run42264590640](https://github.com/alexj11324/Mikka/actions/runs/42264590640) 最大0.00138888889%，7/100/8、Keychain与全部清理通过，但与2cba仍差18个模型/worker/UI路径。这些比较不被投射成最终354f全树原生截图实测。源树比较及各自 artifact 链接完整保留在结构化证据。

## 正式桌面发布与历史失败

[正式504](https://github.com/alexj11324/Mikka/releases/tag/desktop-2026.10000.504) 来源6f9，2026-11-06 16:27:58正常发布，非draft、非prerelease。实际 Developer ID、notarization、staple、生产 fuses、updater/seal 和发布链通过；7个清单文件加manifest共8个资产，GitHub bytes/digests与seal一致。Manifest自身SHA来自seal输出，不声称自包含manifest校验自己；安装包大文件没有额外独立下载，相关限制保留。SBOM覆盖 desktop runtime依赖图，不声称完整包含共享UI。

502因同源Web失败未发布，503/505/506/508因实际main前移被原发布门禁拒绝；508自然失败，其取消候选从未执行。507/509经正常单次cancel202后另查终态确认cancelled，未把202受理当终态；未创建正常release。候选签名、公证或seal通过不等于已发布。Owner要求的桌面Web后代兼容与过期任务取消已按正常PR合入，保留私有overlay、CI、签名、公证、封存与两次await-desktop-web核验；普通await-web/strict E2B不因此放宽。完整旧attempt不在此重复，但全部保留在JSON中。

早期f01冷启动更慢、peer清理失败，409冷启动门槛失败，24e原生功能/冷启动记录与cleanup失败，原生产自动run取消/来源失配、个人workspace managed失败、团队歧义/admin缺失、8180未知locator失败，都保留原结论。取消的性能/一小时/DevZIP从未改写为通过；成功的最新四报告只证明本轮绑定目标。

## 运维、回滚和最终文档交付

现行运行、构建、认证、RPC、Workflow、tracing与回退命令见 [web-runtime.md](../../operations/web-runtime.md)。Owner指定操作回滚目标是 **`dpl_A2gvRemMPjimhZTKYY4Rw4SsgLUN`**，来源184a375f；最近保留的核验为2026-11-06 22:54:07 READY，实际执行前仍须重新核验。63kk/main622只是切换前服务快照，不能擅自代换Owner目标。

桌面可在完全退出后，用 `MIKKA_DESKTOP_RENDERER=hosted` 直接启动应用包二进制，使进程实际继承变量；恢复bundled需再次退出并去掉变量启动。此开关不回滚后端或数据库。代码回滚走正常revert PR，保留数据和向后兼容性，不删deployment、不强推、不执行破坏性down migration。

2026-11-07 **01:37:09 UTC**，两台任务Docker机器通过正常管理GET均确认stopped，未请求旧公共服务URL；此前Medium曾意外running、进程列表0，已按正常流程停止，原因未知。1CPU/2GB控制VM仍用于证据收尾，未在本稿声称已停止。其最终停止由Owner在最后Issue回执确认。

最终改动仅十份Markdown/SVG，保留后来合入的README许可、贡献和任务编号内容。四张架构SVG只调整运行时标签，结构和箭头不变；不修改产品、脚本、工作流或门禁。路径分类仍为docs-only，且不触发桌面release；但正常main push依然要求实际Web构建和发布。文档必须经正常PR、当前所需CI/GitGuardian、正常merge及Web READY后收口。本文的固定生产证据不会因为文档自身产生新SHA就被改写；文档发布和最终资源回执由Issue评论补齐。

## 证据入口与隐私

- [最终生产 run42323706132](https://github.com/alexj11324/Mikka/actions/runs/42323706132) 与 [原6份JSON artifact](https://github.com/alexj11324/Mikka/actions/runs/42323706132/artifacts/13553864414)。
- [实际354f Web发布](https://github.com/alexj11324/Mikka/actions/runs/42321398083)、[完整main CI](https://github.com/alexj11324/Mikka/actions/runs/42321398149)、[PR1580](https://github.com/alexj11324/Mikka/pull/1580)。
- [正式504 release](https://github.com/alexj11324/Mikka/releases/tag/desktop-2026.10000.504)、[原生300PNG artifact](https://github.com/alexj11324/Mikka/actions/runs/42231017214/artifacts/13510164029)。
- [本仓库完整结构化证据](final-evidence.md)、[运行与回滚说明](../../operations/web-runtime.md)、[共享验收工作区](../../acceptance.md#shared-production-acceptance-workspace)。

GitHub artifact 的保留期和权限限制照常生效；完整闭集JSON与原始回执哈希放入Git持久保存。旧Docker下载服务已停止，未执行的90天截图上传不写成已留存。远端 `/vercel` 路径只用于内部回执定位，不作为用户下载链接。报告不包含凭据、Cookie、token、成员邮箱/原始成员ID、原始提示词、私有trace/video/screenshots或原始OTLP。
