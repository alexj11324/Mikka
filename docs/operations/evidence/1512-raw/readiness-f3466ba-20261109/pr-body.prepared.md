## 当前状态：f346 完整 CI 与原始 Native 已通过；生产验收尚未完成

关联 #1512；**本 PR 不自动关闭 issue。ACME 生产已验收案例仍为 0。**

当前候选 **f3466ba479ef51918790f521a288feaef5160e44**，tree **102bc671b4c5e3cf49fcce54025c71b26f817cf2**。它在已通过完整CI/Native的ae10之上，正常 merge 实际 main e78；parents=[ae10,e78]。新增8路径与e78逐项对应，6784个其余blob/mode/type原样保留，两个语言文件仅删除原UI owner的10项旧Shell文案叶，P0三个Errors.taskWorkspace*逐字保留。没有新增设计或改变原UI行为。它从原公开 c0e head 正常前进，依次包含安装器权限修正、Workspace driver、严格404清理修正，再正常 merge 固定 P0 **521db479** 与当时 main **a2198c8**。没有改写或强推父链。

**前一候选 ae10 的 CI42603781956 已于11:15:02 UTC SUCCESS**，实际 checkout `ddbc7e9b8e156493af730f00ed4a6efd3de475b4` 的 tree 与前一候选ae10完全相同。22 jobs=21success+原OIDC skip；head51checks=40success+11原条件skip。

11:27 fresh main 已为 **e78fccffd9dd878edd490b113ea80efcff1525e7**（#1816，8项活动行文案/图标与原断言/文档变更），其Web/Desktop/E2B在11:27进入实际发布；E2B随后私有构建失败由#1506原owner认领诊断，手动Web在12:11仍进行中。该增量已正常合流并发布到本PR开发分支，新的联合tree为`102bc`；前一轮绿色只绑定 `1ac` 受测tree，不能冒充新联合树已验收。没有用新main推断Factory已清理或窗口已释放。

第一合流 commit `82d47c8bf062363d058c79920060f4c688de52ad` 的 parents 为 [f0956eb,521db479]；ae10 层的 parents 为 [82d47c8,a2198c8]。完整远端 tree 按 path/mode/type/blob 核对：第一层6790 leaves、第二层6792 leaves。六份 P0 冲突保留双方行为；第二层只吸收 a219 原10路径，并机械保留 package 和两种语言的所有不相交改动。

**#1636 仍由原 owner 负责先合 main。** 当前相对实际 e78 的479路径包含该上游依赖，不把它冒作本方新增实现或已合主线；#1799 的开发分支先验证完整组合，最终合并再核实际差异、原owner次序、发布者及已进入的有限窗口。

## 问题与修改后的行为

M1 实际发布曾被两个 tracked daemon fixture 的执行权限变化阻断；实际链路又暴露在途 exporter 收尾缺失、返回式拒绝被父 span 记为 OK，以及 Native 完整窗口 SQL 超预算。原失败、未知和原始计量窗口均保留。

- **调用链收尾和错误：** 现有 root-span `waitUntil` 同时覆盖 batch 队列与已经开始的 exporter transport，Logs 并行 flush；响应不等待遥测。在返回式工具错误转换前保留 `coordinator.tool` 子 span，闭集仓库拒绝保留 ERROR 和安全 code，业务返回与权限合同不变。
- **Native 与 SQL：** 纯 snapshot fetcher 使用可撤销的本地发送提示等待正在发送的读取，完成仍须原 response proof、精确 SWR commit、scope 和 revision 检查；不新增 timer、产品查询或轮询。保留后台 fresh policy、原子 enrollment、command snapshot、runs/repos 新鲜 authority/owner/result snapshot 与全部撤权回归。两份 fake blob 内容不变，mode 为100755。
- **真实模型与发布关联：** 保留 daemon 的 generation、trace carrier 与 metadata-only 合同；复用已授权的最小 Codex MCP reader/producer/writer 回归，不带其它性能实验。E2B 诊断只输出闭集关联字段，HTTP trace 明确仅代表提交请求。
- **安装器凭据范围：** 默认空的显式输入覆盖环境继承；16个只读调用明确 opt-in，两个写权限调用匿名。保留下载完整性、30秒/3重定向限制；不把日志 mask 或首跳检查当作子进程隔离。
- **生产验收 driver：** 所有 Factory read/write/cleanup 使用已验证的 Personal selector，拒绝相冲突的 header/query/body selector；以既有 Workspace inventory 和 RPC 做有界 owner-idle 检查。只把精确 `HTTP404 + agentProfileNotFound` 视为合法缺失；权限、scope、未知代码与坏 JSON 均失败，不能误报 profile 已清理。CAS/version/digest、model settings 恢复和 session 收尾保持。

上游 P0 的 Workspace 身份、fresh lease、PAT/跨tenant和迁移边界完整保留；本方新增逻辑没有扩大授权范围或记录 prompt/output/message。语言冲突只合并原 UI owner 的既有文字，没有新设计或改写。

## 已有证据与当前验证边界

当前f346的CI42610943512已于12:08:30 UTC完整SUCCESS，绑定实际checkout855245dba9accc3212dab9fd28af398af1a7e65a/tree102bc。22jobs=21success+原OIDC skip；head51checks=40success+11原条件skip；14workflows全部success。Source361PASS、PG2的18suites/806PASS、Native五份完整原JSON及Root逐项算术分别归档。其余本轮门禁按实际终态记录，未把旧源叶计数冒作本轮原件。没有人为重跑旧run、取消他人发布或改动测试阈值。ae10中输入不相交的证据继续按原source保留，新UI/parity及新whole tree单独判断。

| 证据 | 实际结果 | 对当前候选的边界 |
| --- | --- | --- |
| 安装器原始 RED→GREEN | 旧范围14项9PASS/5FAIL；修正22/22。所有11执行源码与纯30e逐字绑定。 | 已纳入并在本轮正式Core实际执行，全部workflow opt-in检查通过；owner旧lint stdout与其VM删除原件未收录，不扩大其清理声明。 |
| Workspace driver v1 | 原37项保留，完整51/51；原始RED和实际Node执行原件齐全。 | 被严格404修正延伸，未删改原51项。 |
| 严格404 driver | 旧driver+新增12项为2PASS/10FAIL；最终完整63/63、零skip。实际Git正反应用与独审关闭通过。 | 精确绑定当前002b/aab源码；是无账号HTTP fixture，不代替生产P0服务端。 |
| 原c0完整CI | [42590712093](https://github.com/alexj11324/Mikka/actions/runs/42590712093)成功；PG72 suites/3789pass零skip，Core/Integration/daemon/desktop/image/SSR及伴随门禁保留原结果。 | 历史受测 checkout9d8/tree3e09；不能移用为当前组合PASS。 |
| 原c0 Native窗口 | 完整Native398=19+15+364≤Web412=19+0+393；原第一对startup181≤206。1197条ordinal、17operation/78source桶独立复算。 | 历史结果仍保留；本轮ae10使用自己的原始完整窗口，见下行。不能移用旧unknown或crossesEnd计数。 |
| P0521 A2 | Source129108256862于10:38:51成功；CI42598869271于10:39:05成功。root直接读取22作业终态21success+原OIDC skip。 | A1 providerStarted真实失败和未知原因保留；只读metadata，不把head_sha冒充实际checkout或声称所有叶测试重跑。 |
| ae10历史全CI | [42603781956](https://github.com/alexj11324/Mikka/actions/runs/42603781956)完整SUCCESS；Core57targets/4705PASS、Integration29targets/2192PASS+12原skip；真实PG72suites/3904PASS/0skip；Source、daemon、image、Desktop、SSR及13伴随工作流通过。 | 所有实质原件各读一次；actual ddbc/tree1ac。Integration的mixed-lane skip不冒作必需PG跳过，聚合job名称不冒作生产浏览器执行。 |
| ae10历史Native | 完整Native429=19+13+397≤Web435=19+0+416；FIRST pair1 startup197≤hosted230。24records/12checkpoints/8segments/1291ordinal及17+78桶由Root独算；100原parity行通过。 | 原诊断仍incomplete，unknown四窗91/130、87/132、48/69、48/78；overflow=false。原threshold/mask未改，Root未看其PNG。lifecycle restored=false/unchanged，与smoke/parity restored=true分开；实际安装daemon0.0.551/facb不冒作候选发布。 |
| 当前f346全CI | [42610943512](https://github.com/alexj11324/Mikka/actions/runs/42610943512)完整SUCCESS；22jobs=21success+原OIDC skip，51checks=40success+11原条件skip；14workflows全部success。Source361PASS；PG2原18suites/806PASS。 | actual855245/tree102bc；Source与PG2唯一原件已读，其他PG/Core/Integration等按当前job终态记录，不搬用ae10的叶计数。 |
| 当前f346 Native | 完整Native426=19+13+394≤Web435=19+0+416；原FIRST pair1 startup158≤hosted233。Root复算24records/12checkpoints/8segments/2280桶值/1252ordinal，错误0。100原parity行均PASS。 | 原首Native physical5started/3completed/crossesEnd2，logical14/13/crossesEnd1；不能声称都在窗内完成。unknown context/statement四窗91/129、87/132、53/53、53/77，diagnostics仍incomplete；overflow/dropped均0。阈值/mask未改；Root未看parity PNG。实际daemon仍0.0.551/facb。 |
| 旧受控失败/开销 | 旧main1d126的20trace/80span/40ERROR日志完整读回；17条初始未采样保留，handler mean+0.345ms、p95+0.437ms。 | 历史基线，最终发布源仍需20受控失败与600配对样本/100warmup。 |

**CP29标注更正：** Source的63项汇总属于迁移测试。driver的全部63项实际在ae10 Core129114784847的test:dev-local执行，Root已将63个原Subtest名称逐个匹配到PASS；不把Source数字当driver。见[更正回执](https://github.com/alexj11324/Mikka/pull/1799#issuecomment-6739435139)。这不改变原通过结果，也不冒作f346逐项原件复核。

证据入口：
- [CP25：真实pending-dispatch RED/GREEN与75项回归](https://github.com/alexj11324/Mikka/blob/43eac42001f96598c0aa5758290150e5b8bf354d/docs/operations/evidence/1512-raw/pending-dispatch-c0e94d5-20261109/index.safe.json)。
- [CP26：原c0完整CI、原始Native与逐项核算](https://github.com/alexj11324/Mikka/blob/6258f9a410881f3c0f308254cf714d74dd046866/docs/operations/evidence/1512-raw/complete-c0e94d5-20261109/index.safe.json)。
- [CP27：安装器、最终63项driver、固定P521重绑、原始失败与资源回执](https://github.com/alexj11324/Mikka/blob/6dcc538786da81cdcce85aa7139f4b3faaa2cc4d/docs/operations/evidence/1512-raw/prepared-corrections-20261109/index.safe.json)。88 payload / 1,637,538 B，索引另计。两次本方VM实际stop/delete/精确GET404，活动VM为0。
- [CP28：正常合流与初始Source原件](https://github.com/alexj11324/Mikka/blob/4028fc92ba873973a744f8067a19b71dbf6d7abe/docs/operations/evidence/1512-raw/published-ae10f28-20261109/index.safe.json)。
- [CP29：ae10历史完整CI、Native原件、独立算术与有限PostHog查询预检](https://github.com/alexj11324/Mikka/blob/df0d632f4108f2f81a9a8db0e0e64ed099d25f99/docs/operations/evidence/1512-raw/complete-ae10f28-20261109/index.safe.json)。76 payload / 14,615,470 B，索引另计25,130 B。取证VM实际216,210ms后stop/delete/exact404，当前本方活动资源0。PostHog只新增1次synthetic查询，其余13份历史证据按5原echo+2SQL hash+6变更链摘要区分，不能写成14次新执行。
- [CP30：e78八路径正常合流、独审和f346实际checkout绑定](https://github.com/alexj11324/Mikka/blob/e251c44add1c6656bf379d6acd1e3564f5f97f95/docs/operations/evidence/1512-raw/merged-e78-f3466ba-20261109/index.safe.json)。6payload / 1,036,633 B；新CI结果另行收齐。
- 更早候选及原RED继续保留在证据分支历史和issue进度；修改前PR全文也已冻结为blob `7ab4a50373e261369145f3d341fcb13dacb8140a`。

## 完成前的实际门禁

1. 前一候选exact1ac的全CI、type/lint、真实PG及原始Native已闭合。当前f346/102bc正常合流已完成所有6792条leaf核对，本轮全CI/原始Native与Root算术均已通过；有效旧证据保持源绑定，不凭旧绿灯批准新tree。生成脚本没有 `--check` 分支，不能仅凭参数名宣称只读一致性检查；实际调用和生成字节分别验证。
2. 按原owner次序完成正常main合并及实际 Web/daemon/E2B 发布，source/version/seal 对齐；通用SMOKE与ACME正式案例分开。
3. ACME Personal 实际浏览器分别触发官方 Haiku5.5、GPT-6 Luna订阅；覆盖Coordinator/workflow、cloud/E2B/bootstrap、daemon、全部实际generation与completion/delivery/Factory。无API/Pro回退。
4. PostHog原生时间线PNG实际像素、Replay实际渲染、Logs/generation与Notebook交叉关联；固定14查询所有分页、完整计数与两个稳定快照；采集未证明项继续unknown。
5. 最终发布源受控失败保留率、实测额外开销、scout/计费口径及所有本方task/machine/profile/settings/session/浏览器/临时资源收尾。生产全部通过后才关闭#1512。

## 合并风险

**Merge risk: medium**

此评级针对已独审的源改动、f346完整CI与原始Native、e78限定正常合流及P0原owner先合的顺序；不表示可以越过当前实际发布/Factory有限窗口立即merge。

**Alignment: good ✅**
- 对齐#1512完整调用链、异步导出、真实错误、正式发布与原始Native预算。P0是明确上游依赖，原owner先合。

**Impact: large ⚠️**
- 组合涉及Workspace授权/lease、设备authority、异步读取、共享安装入口与上游迁移。六份源冲突和三份JSON机械合并已分别核对，不能整文件覆盖。

**Verification: decent 👀**
- 安装器和driver有真实RED→GREEN、完整原件与独审；f346/102bc新组合全CI与原始Native及Root算术已通过。叶计数保留真实原件边界；最终ACME/PNG实际像素/Replay/完整模型调用链与开销验收仍待实际完成。
- 原A1启动追踪失败原因未知，A2成功不改写历史；未来若再现按原断言定位，不提高阈值。

**Rollback cost: medium 👀**
- 父链可正常revert并重新部署，本方无新schema迁移；组合包含P0自己的迁移/数据归属边界，须由原owner先合并并保持其回滚合同。多服务发布和真实外部模型副作用不能当作单键回滚。

**Error detection: decent 👀**
- 新权限/清理负例覆盖曾遗漏的进程范围与404误报；原seal、Source/PG/Native、E2B/scout和cleanup门禁保留。
- 生产摄入与完整模型调用链尚未证明，不能只凭CI绿色宣称可观测性已达标。

## 可观测性用量与费用（2026-11-09 更新）

截至 **2026-11-09 11:47—11:49 UTC**，官方只读回执确认：项目 `670821` 在 **2026-10-17—11-09 UTC 日级窗口**的 Logs + Tracing **373 MB**（其中独立分项APM324MB、Logs47MB；与组合项差2MB仍unknown）、AI Observability **857 events**、Web Replay **16 recordings**。Root独立复算5×24日桶、next=null；末日0不证明当日没有摄入，且这些计量不证明本issue案例通过或Replay已播放。

组织级本账期另报 **Logs447MB / AI1117events / Replay18recordings**，与项目口径差额未知，不混算。组织仍为 **free**、无active subscription，cap为 **10,000MB / 100,000events / 5,000recordings**，均未超限；账期 **2026-10-17 17:45:01.620—11-16 17:45:01.620 UTC**。美元字段为null，实际美元费用保留 **unknown**，不能称$0。本次没有修改plan/cap/retention。

APM/AI两个scout均enabled/active/emit=true、间隔1440分钟、Inbox开启且无Slack/Webhook、连续失败0；今日2/100次、余98。last_run_at为06:30/07:30，只是metadata，未独立证明报告已完成；下一次精确运行时间未知。

当前官方价格：Logs/Tracing 共享每月10 GB免费，超出后10–300 GB档 **$0.25/GB**、300 GB以上 **$0.15/GB**；AI每月10万事件免费，首个付费档 **$0.000350/event**；Web Replay每月5,000条免费，首个付费档 **$0.0050/recording**。来源：[Logs/Tracing](https://posthog.com/logs/pricing)、[AI](https://posthog.com/ai-observability/pricing)、[Replay](https://posthog.com/session-replay/pricing)。

容量估算沿用文档的明确假设：以2026-11-05报告的 **73 MB traces/day** 为旧基线，30天为2.19 GB；若其中10%所代表的既有流量由10%采样改为全量，且流量和每条大小不变，再假设100 runs/day、每run新增25 spans＋10 logs、每条1 KB，则约 **4.27 GB/月**。若该既有流量全部改为全量，则为 **21.9 GB/月（未含新增遥测）**，按公开付费档折合摄入费约 **$2.98/月**；这是场景计算，不是实际需求、当前账单或提额授权。同样，100 runs/day×5次generation仅为 **15,000 generation events/月**，额外 `$ai_*` 事件另计；100条Web录制/day为 **3,000 recordings/月**。PostHog的事件/摄入费与模型提供商费用分开，订阅模式缺少单次收费回执时保留 **unknown**，不以API目录价或零值冒充实际订阅逐次账单。
