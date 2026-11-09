## 当前状态：已准备完整合流，等待新源码自己的 CI 与生产验收

关联 #1512；**本 PR 不自动关闭 issue。ACME 生产已验收案例仍为 0。**

当前候选 **ae10f28aa471dbfc64f04d981b8934d374476259**，tree **1acbe0b8d50a7102543e24b9bd0395355bcba438**。它从原公开 c0e head 正常前进，依次包含安装器权限修正、Workspace driver、严格404清理修正，再正常 merge 固定 P0 **521db479** 与实际 main **a2198c8**。没有改写或强推父链。

第一合流 commit `82d47c8bf062363d058c79920060f4c688de52ad` 的 parents 为 [f0956eb,521db479]；最终 parents 为 [82d47c8,a2198c8]。完整远端 tree 按 path/mode/type/blob 核对：第一层6790 leaves、第二层6792 leaves。六份 P0 冲突保留双方行为；第二层只吸收 a219 原10路径，并机械保留 package 和两种语言的所有不相交改动。

**#1636 仍由原 owner 负责先合 main。** 当前相对 a219 的479路径包含该上游依赖，不把它冒作本方新增实现或已合主线；#1799 的开发分支先验证完整组合，最终合并再核实际差异、原owner次序、发布者及已进入的有限窗口。

## 问题与修改后的行为

M1 实际发布曾被两个 tracked daemon fixture 的执行权限变化阻断；实际链路又暴露在途 exporter 收尾缺失、返回式拒绝被父 span 记为 OK，以及 Native 完整窗口 SQL 超预算。原失败、未知和原始计量窗口均保留。

- **调用链收尾和错误：** 现有 root-span `waitUntil` 同时覆盖 batch 队列与已经开始的 exporter transport，Logs 并行 flush；响应不等待遥测。在返回式工具错误转换前保留 `coordinator.tool` 子 span，闭集仓库拒绝保留 ERROR 和安全 code，业务返回与权限合同不变。
- **Native 与 SQL：** 纯 snapshot fetcher 使用可撤销的本地发送提示等待正在发送的读取，完成仍须原 response proof、精确 SWR commit、scope 和 revision 检查；不新增 timer、产品查询或轮询。保留后台 fresh policy、原子 enrollment、command snapshot、runs/repos 新鲜 authority/owner/result snapshot 与全部撤权回归。两份 fake blob 内容不变，mode 为100755。
- **真实模型与发布关联：** 保留 daemon 的 generation、trace carrier 与 metadata-only 合同；复用已授权的最小 Codex MCP reader/producer/writer 回归，不带其它性能实验。E2B 诊断只输出闭集关联字段，HTTP trace 明确仅代表提交请求。
- **安装器凭据范围：** 默认空的显式输入覆盖环境继承；16个只读调用明确 opt-in，两个写权限调用匿名。保留下载完整性、30秒/3重定向限制；不把日志 mask 或首跳检查当作子进程隔离。
- **生产验收 driver：** 所有 Factory read/write/cleanup 使用已验证的 Personal selector，拒绝相冲突的 header/query/body selector；以既有 Workspace inventory 和 RPC 做有界 owner-idle 检查。只把精确 `HTTP404 + agentProfileNotFound` 视为合法缺失；权限、scope、未知代码与坏 JSON 均失败，不能误报 profile 已清理。CAS/version/digest、model settings 恢复和 session 收尾保持。

上游 P0 的 Workspace 身份、fresh lease、PAT/跨tenant和迁移边界完整保留；本方新增逻辑没有扩大授权范围或记录 prompt/output/message。语言冲突只合并原 UI owner 的既有文字，没有新设计或改写。

## 已有证据与当前验证边界

| 证据 | 实际结果 | 对当前候选的边界 |
| --- | --- | --- |
| 安装器原始 RED→GREEN | 旧范围14项9PASS/5FAIL；修正22/22。所有11执行源码与纯30e逐字绑定。 | 已纳入当前候选；整仓组合仍由本轮CI执行。owner lint stdout与其VM删除原件未收录，不扩大清理声明。 |
| Workspace driver v1 | 原37项保留，完整51/51；原始RED和实际Node执行原件齐全。 | 被严格404修正延伸，未删改原51项。 |
| 严格404 driver | 旧driver+新增12项为2PASS/10FAIL；最终完整63/63、零skip。实际Git正反应用与独审关闭通过。 | 精确绑定当前002b/aab源码；是无账号HTTP fixture，不代替生产P0服务端。 |
| 原c0完整CI | [42590712093](https://github.com/alexj11324/Mikka/actions/runs/42590712093)成功；PG72 suites/3789pass零skip，Core/Integration/daemon/desktop/image/SSR及伴随门禁保留原结果。 | 历史受测 checkout9d8/tree3e09；不能移用为当前组合PASS。 |
| 原c0 Native窗口 | 完整Native398=19+15+364≤Web412=19+0+393；原第一对startup181≤206。1197条ordinal、17operation/78source桶独立复算。 | 当前组合需自己的原窗口；unknown归因与crossesEnd保留，不挑样本、不裁剪邮件/auth/PKCE/后台。 |
| P0521 A2 | Source129108256862于10:38:51成功；CI42598869271于10:39:05成功。root直接读取22作业终态21success+原OIDC skip。 | A1 providerStarted真实失败和未知原因保留；只读metadata，不把head_sha冒充实际checkout或声称所有叶测试重跑。 |
| 当前ae10组合 | 两次正常合流、所有leaf与机械冲突已核；完整新CI待执行。 | 不借用上述历史绿灯，实际checkout/tree、生成件、全部必需suite、原始Native窗口和cleanup都需收齐。 |
| 旧受控失败/开销 | 旧main1d126的20trace/80span/40ERROR日志完整读回；17条初始未采样保留，handler mean+0.345ms、p95+0.437ms。 | 历史基线，最终发布源仍需20受控失败与600配对样本/100warmup。 |

证据入口：
- [CP25：真实pending-dispatch RED/GREEN与75项回归](https://github.com/alexj11324/Mikka/blob/43eac42001f96598c0aa5758290150e5b8bf354d/docs/operations/evidence/1512-raw/pending-dispatch-c0e94d5-20261109/index.safe.json)。
- [CP26：原c0完整CI、原始Native与逐项核算](https://github.com/alexj11324/Mikka/blob/6258f9a410881f3c0f308254cf714d74dd046866/docs/operations/evidence/1512-raw/complete-c0e94d5-20261109/index.safe.json)。
- [CP27：安装器、最终63项driver、固定P521重绑、原始失败与资源回执](https://github.com/alexj11324/Mikka/blob/6dcc538786da81cdcce85aa7139f4b3faaa2cc4d/docs/operations/evidence/1512-raw/prepared-corrections-20261109/index.safe.json)。88 payload / 1,637,538 B，索引另计。两次本方VM实际stop/delete/精确GET404，活动VM为0。
- 更早候选及原RED继续保留在证据分支历史和issue进度；修改前PR全文也已冻结为blob `7ab4a50373e261369145f3d341fcb13dacb8140a`。

## 完成前的实际门禁

1. 当前合流源全CI、整仓type/lint、真实PG、canonical生成输出、原完整Native登录和原第一对startup。生成脚本没有 `--check` 分支，不能仅凭参数名宣称只读一致性检查；实际调用和生成字节分别验证。
2. 按原owner次序完成正常main合并及实际 Web/daemon/E2B 发布，source/version/seal 对齐；通用SMOKE与ACME正式案例分开。
3. ACME Personal 实际浏览器分别触发官方 Haiku5.5、GPT-6 Luna订阅；覆盖Coordinator/workflow、cloud/E2B/bootstrap、daemon、全部实际generation与completion/delivery/Factory。无API/Pro回退。
4. PostHog原生时间线PNG实际像素、Replay实际渲染、Logs/generation与Notebook交叉关联；固定14查询所有分页、完整计数与两个稳定快照；采集未证明项继续unknown。
5. 最终发布源受控失败保留率、实测额外开销、scout/计费口径及所有本方task/machine/profile/settings/session/浏览器/临时资源收尾。生产全部通过后才关闭#1512。

## 合并风险

**Merge risk: high**

**Alignment: good ✅**
- 对齐#1512完整调用链、异步导出、真实错误、正式发布与原始Native预算。P0是明确上游依赖，原owner先合。

**Impact: large ⚠️**
- 组合涉及Workspace授权/lease、设备authority、异步读取、共享安装入口与上游迁移。六份源冲突和三份JSON机械合并已分别核对，不能整文件覆盖。

**Verification: poor ⚠️**
- 确定的安装器和driver缺陷已有真实RED→GREEN、完整原件与独审；当前组合CI尚未执行，最终ACME/PNG/Replay/开销验收仍待实际完成。
- 原A1启动追踪失败原因未知，A2成功不改写历史；未来若再现按原断言定位，不提高阈值。

**Rollback cost: medium 👀**
- 父链可正常revert，本方无新schema迁移；组合仍包含P0自己的迁移/数据归属边界，须由原owner先合并并保持其回滚合同。

**Error detection: decent 👀**
- 新权限/清理负例覆盖曾遗漏的进程范围与404误报；原seal、Source/PG/Native、E2B/scout和cleanup门禁保留。
- 生产摄入与完整模型调用链尚未证明，不能只凭CI绿色宣称可观测性已达标。

## 可观测性用量与费用（2026-11-09 更新）

截至 **2026-11-09 00:50:44 UTC**，官方 Billing 对项目 `670821` 的 **2026-10-17—11-09 UTC 日级窗口**报告：Logs + Tracing **175 MB**、AI Observability **189 events**、Web Replay **0 recordings**。所属组织仍为 **free**，无有效付费订阅；对应组织产品 cap 为 **10,000 MB / 100,000 events / 5,000 recordings**，本次未修改 plan、cap 或 retention。该窗口末日未完，且账期实际边界为 **2026-10-17 17:45:01.620—11-16 17:45:01.620 UTC**，因此这些日级计量不冒充精确项目账单，也不用于推断峰值需求。当前官方价格：Logs/Tracing 共享每月10 GB免费，超出后10–300 GB档 **$0.25/GB**、300 GB以上 **$0.15/GB**；AI每月10万事件免费，首个付费档 **$0.000350/event**；Web Replay每月5,000条免费，首个付费档 **$0.0050/recording**。来源：[Logs/Tracing](https://posthog.com/logs/pricing)、[AI](https://posthog.com/ai-observability/pricing)、[Replay](https://posthog.com/session-replay/pricing)。

容量估算沿用文档的明确假设：以2026-11-05报告的 **73 MB traces/day** 为旧基线，30天为2.19 GB；若其中10%所代表的既有流量由10%采样改为全量，且流量和每条大小不变，再假设100 runs/day、每run新增25 spans＋10 logs、每条1 KB，则约 **4.27 GB/月**。若该既有流量全部改为全量，则为 **21.9 GB/月（未含新增遥测）**，按公开付费档折合摄入费约 **$2.98/月**；这是场景计算，不是实际需求、当前账单或提额授权。同样，100 runs/day×5次generation仅为 **15,000 generation events/月**，额外 `$ai_*` 事件另计；100条Web录制/day为 **3,000 recordings/月**。PostHog的事件/摄入费与模型提供商费用分开，订阅模式缺少单次收费回执时保留 **unknown**，不以API目录价或零值冒充实际订阅逐次账单。
