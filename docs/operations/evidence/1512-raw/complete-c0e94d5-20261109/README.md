# #1512 Checkpoint 26：c0e 完整 CI 与原始 Native 验收

## 当前结论

候选 `c0e94d594f1ecf4f5edc25904912702e61fce86b` 的 CI [42590712093](https://github.com/alexj11324/Mikka/actions/runs/42590712093) 于 2026-11-09 09:31:29 UTC 完成 success。实际原日志 checkout 为 `9d8aab6986e474ea2df8f62091d97dc5aa992420`，tree `3e09885ffb34a9c04fc8a7ac5b8b88e3415f7325` 与候选相同；全 43 checks 中 36 success / 7 原条件 skipped。

**这只证明固定 c0e 源的本轮 CI。PR 尚未合并，ACME 生产验收通过案例仍为 0，#1512 保持 OPEN。** 共享安装器的完整 job token 进入 pnpm lifecycle 是已确认的合并前问题，原 owner 正统一修正；随后还需实际 P0 工作区源合流及独立验证。

## 原始 Native 窗口

| 窗口 | Native | Web / hosted |
|---|---:|---:|
| 完整登录 | 398 = 19 + 15 + 364 | 412 = 19 + 0 + 393 |
| 原始第一次启动配对 | 181 | 206 |

完整邮件认证、PKCE、导航与并发后台 SQL 均保留。12 checkpoints、8 segments、4 totals 共 24 记录，每条 17 operation / 78 source 桶守恒；1,197 条 query ordinal 连续且与桶相符，没有丢弃、overflow、扣除或选择后续 pair。root 对完整原 lifecycle 独立计算，使用与上一轮相同的 8,115B verifier。

诊断原状态仍为 incomplete。Unknown context / statement 分别为 Native login 94/135、Web 87/139、Native first 48/73、hosted first 48/82；unknownReadings=0 是另一个计数。Native first 有一次 pollTaskRuns crossesEnd，物理 started/completed 8/7、逻辑 19/18；不能写成所有 RPC 都在窗口内结束。

本轮不能证明上一源码 hosted139→206 的变化由某个修复造成。上一 1ffa 首对183>139 和所有失败、否决实验继续保留，不用本轮绿色覆盖历史原件。

## 其它真实执行

- 全 selection：57 Core、29 Integration、72 PG suites / 4 shards；原 selection 和源绑定见 Checkpoint25。
- Required PG：72/72、91 Node summaries，共 3,789 pass，0 fail/cancel/skip/todo。root 按全部72行及546个独立计数单元再核，不重复下载原日志。
- Core Node summaries 为4,647 pass；Integration 为2,184 pass / 12显式 skip。Daemon1577 pass / 2既有 skip。不同runner及重叠job不合计成“独立测试总数”。
- Source 的 canonical generator、整仓类型与 lint 实跑通过；DesktopChecks 实际运行原 read-batch 文件的13个顶层用例，填补最小75-case VM没有执行的检查。
- 镜像正常安装、31条合成消息/回复、真实daemon注册与撤销、打包桌面流程与数据保留通过。6容器、3卷和1网络有实际删除记录；PR publish 跳过不算生产发布。
- Native smoke、100张屏幕/主题比较记录、同一个签名包的3次独立进程加密检查通过。23个屏幕记录存在非零像素差，最大 ratio0.00003935185185185185，均低于原0.001门槛；不宣称逐像素完全相同。root未目视原截图，仅校验原JSON与完整成员hash索引。
- 9个 companion runs、14实际jobs自然结束success；13实际checkout9d8。Browser gate仅echo；Site-search是7个HTTP API测试，不能把Playwright的chromium标签当成真实浏览器运行。
- Analytics SSR为合成启用且外网阻断，3真实匿名页面pageErrors0；不证明PostHog生产摄入。

## 清理、隐私及限制

Lifecycle/smoke 的 workspaceNameCleanup.restored=false 原样保留。Lifecycle owner/peer 封存基线 before=false/false、after=true/true，原件说明变化来自workspace_audit_outbox；其它六阶段通过、nativeCleaned=true、账号观察released。Parity restored=true。CI实际安装daemon0.0.551/protocol3/revisionfacb389f，与应用revision不是同一项。

唯一 Native 取证 VM 已于09:35:00.590UTC stop，随后delete，exact GET resume=false得到404。实际运行168,192ms、CPU5,200ms、ingress14,924,015B、egress394,975B；无零成本声明。其它worker的CI服务删除依据分别保留；custody job 原文允许条件保留BYOS容器，未证明实际删除，不能一概称所有CI资源已清理。

原日志单次读取后逐字UTF-8归档，BOM/ANSI保留；原JSON未改写。原artifact ZIP各下载一次且hash/API字节数/ZIP完整性一致。310成员完整索引留存；完整ZIP、PNG和签名下载URL不再转存。公开内容凭据形状复核无未解决命中，但日志mask不等于安装子进程隔离。

共享安装器进程scope审查与 P061 的428路径/8交集审查同包封存。Factory Team-first/no-cookie默认选择反例已在#1636评论6736865555协调，属源码推导，未假称ACME实遇；ownerIdle跨Workspace适配尚不在本轮c0e受测源。

## 主要入口

- `review/root-terminal.safe.json`：固定源最终结论、真实边界与未完成项。
- `review/root-native-budget.safe.json`：完整原窗算术/RPC/ordinal复核。
- `review/root-native-package-cleanup.safe.json`：五原JSON哈希、画面比较数值、包与清理复核。
- `native/index.safe.json`：23份Native payload、原件及一次读取/VM清理。
- `ci-c0e94d/pg/index.safe.json`：4分片与aggregate原日志、72-suite执行台账。
- `ci-c0e94d5/companion/index.safe.json`：伴随工作流原件与语义边界。
- `ci/terminal-metadata.safe.json`：终态22个CI job和43 checks。
- `review/shared-installer-token-scope.safe.json`：未解决进程范围问题。
- `p0-1636-premerge-61f-20261109/index.safe.json`：固定P0源码兼容性审查。

前一检查点：[Checkpoint25](https://github.com/alexj11324/Mikka/blob/43eac42001f96598c0aa5758290150e5b8bf354d/docs/operations/evidence/1512-raw/pending-dispatch-c0e94d5-20261109/index.safe.json)。源变更、75-case真实时序、原baseline失败、完整selection和源绑定在该处，不重新采样。
