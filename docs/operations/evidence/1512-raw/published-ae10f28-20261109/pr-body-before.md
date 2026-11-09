## 当前状态：本轮完整 CI / 原始 Native 预算通过，待凭据与 P0 联合源修正（2026-11-09 09:47 UTC）

**尚不能合并；ACME 生产已验收案例仍为 0，#1512 保持 OPEN，本 PR 不自动关闭 issue。**

当前 head **c0e94d594f1ecf4f5edc25904912702e61fce86b**、tree **3e09885ffb34a9c04fc8a7ac5b8b88e3415f7325**。[CI42590712093](https://github.com/alexj11324/Mikka/actions/runs/42590712093) 于09:31:29 UTC完成SUCCESS；43 checks为36 success / 7原条件skip。原日志实际checkout **9d8aab6986e474ea2df8f62091d97dc5aa992420**，Git commit/tree及两父已独立绑定，不能用未来P0联合源借用这次结果。

| 实际检查 | 本轮结果 |
| --- | --- |
| Source / Core / Integration | canonical generator、整仓typecheck/lint通过；全57Core和29Integration执行目标与selection完全一致。Node summary分别4647pass及2184pass/12显式skip。 |
| PostgreSQL | 72suite / 4shards、91 Node summaries，**3789pass、0fail/cancel/skip/todo**；root逐72行和546计数单元独立重算。 |
| Image / Desktop / Analytics | 镜像正常安装、31条合成回复、真实daemon注册/撤销、打包桌面和数据保留通过；Desktop原read-batch13顶层回归实跑，填补最小VM缺口。SSR三匿名页pageErrors0，外部网络阻断不算PostHog摄入。 |
| Native完整登录 | **398 = 19 + 15 + 364 ≤ Web412 = 19 + 0 + 393**。完整邮件/auth/PKCE/导航/后台SQL保持。 |
| Native原始第一对启动 | **181 ≤ hosted206**；保留pair1，不重跑挑样本。 |
| 伴随工作流与最终gate | 9 companion runs / 14实际jobs成功；UI strict成功。Browser gate仅echo，Site-search为HTTP API tests，PR release skip不算发布。 |

Native原件的12检查点、8段、4总计共24记录，17operation/78source桶、全部1197条ordinal均由两个读取者独立核对。diagnostics仍incomplete：Native login unknown context/statement94/135、Web87/139、first Native48/73、hosted48/82；一次Native pollTaskRuns crossesEnd原样保留。**上一源码首对183>139继续是历史RED，本轮不证明44条SQL全部由该修复消除，也不为hosted139→206编造因果。**

### 本次实现及证据

真实React/SWR/PersistentReadCache/HydrateReadCache与Native MessageChannel复现了fetcher在Live ready前入场、HTTP在ready后发送且flush时响应仍pending的补读缺口。仅原三个纯snapshot fetcher获得可撤销的本地发送提示；它只允许等待，完成后仍须原response proof、精确SWR commit、scope和全部revision检查。重复dispatch、多次capture、supersession会撤销并唤醒。无新timer/SQL/polling，无RPC whitelist扩展。

[Checkpoint25](https://github.com/alexj11324/Mikka/blob/43eac42001f96598c0aa5758290150e5b8bf354d/docs/operations/evidence/1512-raw/pending-dispatch-c0e94d5-20261109/index.safe.json) 保存原六场景5PASS/1RED、最终完整75/75（含真实404回退）、19条时序诊断、六源码和patch往返证明、49路径全树合流及原selection。最小VM未跑的整仓类型/lint/read-batch已由本轮正式CI实际补齐。

[Checkpoint26不可变索引](https://github.com/alexj11324/Mikka/blob/6258f9a410881f3c0f308254cf714d74dd046866/docs/operations/evidence/1512-raw/complete-c0e94d5-20261109/index.safe.json) 保存 **72payload / 11,282,757B**，索引23,925B / SHA256 `4cbf1dfde53fabf04e42f914bd6a08ee232af762e7379458d8e0cf6d58310325`，远端逐字核对。包含完整原日志、五Native原JSON、原artifact成员hash、root算术/RPC/来源/终态复核和清理。历史失败不改写。

### 当前合并前待办

1. **安装凭据范围：** 当前c0e仍含自动向所有pnpm lifecycle传完整job token的旧入口，image/packages:write与screenshots/contents:write尤其相关。没有观察到泄漏；HTTP redirect限制和日志mask不能解决进程范围。原owner已发布独立pure **30e54e5f9e97ed059bb9121edeeb20fa2578e286**，默认无凭据、仅确认API只读caller显式opt-in、写caller不注入。我们正在核11文件增量和已有执行receipt，尚未吸收到本PR，不能用旧CI宣布修复。
2. **P0工作区合流：** 固定P061f共428路径，与我方49路径直接交集8。必须同时保留租户限制、coordinator span、pending callback和isCurrent保护，并适配queued-run fixture及canonical routes。正常Factory无cookie选择的Team-first反例已在[#1636](https://github.com/alexj11324/Mikka/pull/1636#issuecomment-6736865555)给出源码依据；没有声称实际ACME已命中。验收driver的Factory显式选择和跨授权Workspace空闲核查正在实现，正常浏览器合同由P0 owner闭合。
3. **实际发布与账号窗口：** 本方无Main/Web/ACME hold，尊重#1608实际08:55–10:25UTC有限段及提前释放；未来请求不视为已生效锁。联合源就绪后以届时fresh main、真实writer和cleanup回执安排普通merge与生产验收。

Native lifecycle/smoke的workspaceNameCleanup.restored=false与sealed baseline after=true分别保留；parity restored=true。取证VM已09:35 stop/delete/exactGET404（168192ms、CPU5200ms，费用未知）。Image6容器/3卷/1网络有删除回显；companion custody的条件保留容器没有独立删除证明，不能写“所有CI资源已清理”。

生产仍须最终发布源上的ACME Personal官方Haiku5.5与GPT-6 Luna双案例、完整同trace/每次generation、PostHog真实PNG与Replay、Logs/Notebook对账、受控失败、额外延迟和最终资源/费用收尾。

## 历史候选1ffa：CI 与原始首启预算未通过（2026-11-09 08:27 UTC）

**当前不能合并。** PR head **1ffa581f16319381054e0636ae41e6292719a1fe**，实际 CI checkout **c3b547d0e4d20692643fc95a5194b7ee8cf7f5c0**，tree同为 **bc4d584fa651385886e79dc6359b1b43324425d1**。这是普通双父merge，parents=[025118ed953ab80803ac3ba9548c3a309c5c69b4,89eae89e9e79422e0a8b4b1346aa1c7fb6470016]；只expected025/force=false快进本PR分支。未写main、未生产dispatch。**ACME生产已验收case仍0，本PR不自动关闭#1512。**

### 当前实际结果

[CI42580506632](https://github.com/alexj11324/Mikka/actions/runs/42580506632)已终态failure；全部43checks=34success+2failure+7原有条件skip，9伴随workflow均success。

| 检查 | 当前精确源的实际结果 |
| --- | --- |
| Image | 正常Docker frozen install下载官方ffmpeg-static5.3.0/b6.1.1/linux-x64.gz时HTTP504/exit1。app、31条synthetic、daemon和Desktop阶段未执行；没有artifact files。 |
| UI strict | 因必需IMAGE结果失败而失败；未另行推断UI缺陷。 |
| Source / Core / Integration | canonical generator、typecheck、lint通过；Core57及Integration29逐目标与原selection一致。 |
| PostgreSQL | 72suite、91个Node summary、**3789pass/0fail/0skip/0cancel/0todo**；root独立重算完整选集与分片。DB aggregate只是汇总/计时，其名称不代表执行浏览器。 |
| Daemon | **1577pass+2原skip**，139filespass/1skip。 |
| Native完整登录 | **394=19+13+362 ≤ Web412=19+0+393**，通过。 |
| Native原始第一对启动 | **bundled183 > hosted139**，预算未通过。packaged job的success不能替代本条验收。 |

完整原登录、邮件/PKCE、自动导航、后台读取和第一对原窗均保留，未扣除未知项或挑选后续pair。12checkpoints+8segments+4totals的17operation/78source桶、1128连续query ordinal由两个读取者独立核对守恒。unknownReadings=0、overflow=false；diagnostics仍incomplete（Native91/134、Web87/139、bundled53/73、hosted37/55）。

首启Native7physical/18logical、hosted12/12；六个RPC第二读37条SQL、三个API第二读16条、首批合并省9条，净差44。当前窗没有/v1/devices/*查询。原服务器证据不含客户端readBoundary/Live ready/effective-scope事件，尚不能判定全部补读的原因。仅向Provider传bootstrap workspace提示无法覆盖实际hooks的显式未解析scope，不能作为已证修复。正在真实React/SWR fixture验证缓存恢复、watch gap与dispatch/commit次序；不削弱新鲜度、授权或原预算。

Image与[#1810共享修复协调](https://github.com/alexj11324/Mikka/pull/1810#issuecomment-6734933057)；其旧候选也有实际安装失败，尚未认定解决。未盲重跑、未跳过gate。

[Checkpoint24不可变索引](https://github.com/alexj11324/Mikka/blob/05ab79fa8862867c6607c2574c70cef932d229a8/docs/operations/evidence/1512-raw/complete-1ffa581-20261109/index.safe.json) 包含73payload/10,999,625B，索引19,890B（SHA256 dd21800b1f2ebbafc8938a3145920862a6df9778dc41c749f6cb190cbda0c165，远端逐字核对）。包含当前完整原日志、Native原件、独立算术、诊断和清理。source/selection在[Checkpoint23](https://github.com/alexj11324/Mikka/blob/35f0d803cd50e7736281bab0ebe0120868042046/docs/operations/evidence/1512-raw/union-main89-1ffa-20261109/index.safe.json)。[本轮issue进度](https://github.com/alexj11324/Mikka/issues/1512#issuecomment-6735582379)。

main927→89的91路径与own33直接交集0；远端6744个blob逐叶核对，own33与其余main6711完整保留。fake仍为原blob/100755，generated联合hash保留。TaskDetail挂载与parity谓词变化已核对，但完整登录/第一对均止于Coordinator根页usable()；没有把该变化写成已证额外SQL。

artifact取证VM已stop/delete/exactGET404，206431ms/CPU7284ms，费用未知；四PG容器与四网络已移除。Native lifecycle/smoke workspaceNameCleanup.restored=false、sealed owner/peer after=true分别保留；companion部分finalizer没有独立最终结果仍为unknown。

07:25 main窗口已[撤回](https://github.com/alexj11324/Mikka/pull/1752#issuecomment-6734618751)，从未merge；本方无main/Web/SMOKE/ACME占用。历史通过结果只绑定其精确源，不能覆盖当前失败。

## 上一候选025的完整源码与原生证据（2026-11-09 07:10 UTC）

**上一候选 head025118ed，实际 checkout0b2b8a，tree均为6da320。** [CI42573554116](https://github.com/alexj11324/Mikka/actions/runs/42573554116) 已06:54:46 SUCCESS；43 checks=36 success+7原有条件skip，0失败/在途，9伴随workflow均success。生产ACME通过数仍0，本PR不自动关闭#1512。

[Checkpoint 22 不可变索引](https://github.com/alexj11324/Mikka/blob/336968cbc1dd4f92bf373f926d62938ef29303a3/docs/operations/evidence/1512-raw/complete-025118ed-20261109/index.safe.json) 保存51 payload/3,581,604B，包含Native/UIstrict原件、14 companion原日志、image原件、独立全窗口复算程序与回执、精确CI身份和清理。Source/PG/Replay修复的原件在[Checkpoint 21](https://github.com/alexj11324/Mikka/blob/fe81d04de2c6938b5dc866312b0f3163b69d2b7a/docs/operations/evidence/1512-raw/replay-opt-in-025118ed-20261109/index.safe.json)继续保留。

- 原始完整登录 **Native361=19+13+329 ≤ Web412=19+0+393**；原始第一对启动 **179≤201**。两个独立读取者从同一原始lifecycle复算24记录、17+78桶、1153连续ordinal全部守恒，未扣减邮件/PKCE/自动导航/后台。unknownReadings=0，diagnostics仍incomplete，未知context/statement原数保留。
- Native实际14 physical/36 logical starts；Web35/35。两条跨窗口终点请求保留并后来实际200。相对旧f886的动作量变化已单列，不能声称所有查询减少均为代码收益。
- Full selection57Core+29Integration+72DB；PG3787tests全部pass；daemon实际1574pass+2原skip。正式generator --check、类型规则、Node18预期拒绝/Node22实际安装、packaged lifecycle8/smoke10/parity100/crypto均通过。
- lifecycle/smoke的workspaceNameCleanup.restored仍false，after sealed baseline true分别记录。唯一取证VM已stop/delete/exactGET404；219102ms/CPU8798ms，成本未知。Image六容器三卷一网络Removed；companion个别fixture缺独立最终清理回执的边界不省略。
- 这些证明精确head025/checkout0b，不自动证明后来main854组合或任何生产模型/Replay/PNG。已逐路径核main854新增10文件与本方33文件无直接交集；候选冻结，实际窗口和发布前再核最新main与writer，用普通merge保全。

[本轮完整进度](https://github.com/alexj11324/Mikka/issues/1512#issuecomment-6734374938) · [实际ready协调](https://github.com/alexj11324/Mikka/pull/1752#issuecomment-6734375193)

## 025候选发布记录与Replay补充（2026-11-09 06:31 UTC）

当时 head **025118ed953ab80803ac3ba9548c3a309c5c69b4**，tree **6da320a6f476624ba2e61ca7a1f5c704a3fdae25**。新 [CI 42573554116](https://github.com/alexj11324/Mikka/actions/runs/42573554116) 和9个伴随workflow已于06:31:29真实启动，**06:31初始时点尚未完整通过；现已完成，见上方不可变证据**。合成merge记录0b2b8a5296fa9ccda2a7f9921c26c2ff9b93ba02已与后续实际checkout日志逐项核实。没有生产ACME case、Replay播放或新source性能的通过声明；不自动关闭#1512。

生产前源码核查发现固定posthog-js 1.438.13会把标准Playwright的自然`$snapshot`当作automation丢弃，发生在before_send之前，使原提交前Replay-ready门槛无法满足。这是固定源码与[官方配置合同](https://posthog.com/docs/references/posthog-js/types/PostHogConfig)确认的阻断，没有把所有历史Replay0归因于它。

本轮新增9个既有文件的最小修复：

- fresh runner-owned context在首page前，仅为官方origin、/mikka路径边界和顶层document安装非枚举内存deadline marker；只读helper接受未来≤10min的own data descriptor，拒绝accessor、继承、无效及过期值。
- 仅明确opt-in的SDK实例使用公开`opt_out_useragent_filter`，普通实例仍false；不改UA/WebDriver/consent/项目设置，不暴露SDK实例，不合成snapshot。该期限只约束初始化资格，不是SDK自动恢复计时器；实例随owned context清理结束。
- 现有隐私过滤器对普通事件和$snapshot只保留官方`$browser_type='bot'|'browser'`闭集，其他值拒绝，不增加UA或任意内容。自然同session snapshot、双版本检查、账号/权限、一次点击和全部cleanup逻辑保留。
- 三个既有测试文件补边界回归；driver与tracing文档说明真实自动化和实际证据边界，并纠正已实现temporary-if-absent/restore-implicit的过时chosen=false说明。

作者与独立审查均确认9份exact blobs；source-bound V8检查为marker/config/注入34项、分类25项通过，旧对应用例1项+4项RED保留。**这些不冒称Node套件、真实SDK、Chromium或生产执行。** 实际CI入口core46/test:analytics与core53/test:dev-local覆盖这三份测试，scripts变化触发full，使用skip-nx-cache。

发布前fresh检查发现main已合入#1790为 **927260894305e066e15a4ad50114abce433e6001**，旧临时候选没有推送或触发CI。最终普通父链：1fa→merge88 e1a7f25→browser fix 34d0f2b→merge927 **025118ed**；最终parents=[34d0f2b,9272608]。只一次expected1fa/force=false快进本分支，未写main。相对927共33paths；6729 blobs逐项核对，本方33正确、其余6696保全。唯一共改是两份generated：保留main新的claim hash9bb84ac，同时保留own runs0d53b2c/repos5da882d；仍243routes/315methods，JSON/TS逐项一致。canonical generator已在本轮实际checkout的Source checks正式执行并通过。

本方没有main/Web/SMOKE/ACME占用窗口；接续仍按届时实际writer/账户状态和新head完整门禁。

## 问题与目标

关联 #1512；本 PR 不自动关闭 issue。

上一候选 **1fa3becd9b69e27c7a0229762750b6fa7e9497fc**，tree **0ecc16ec86a3650f85170f46bc4b996700c420d8**。普通 merge `eec2d4859f86a3894f507065c562227361a7c593` 的两个 parents 是旧候选 `548790b4…` 和实际 main `d72a1982…`；随后单父提交 `c1487ebf…` 仅复用 #1788 的三文件 MCP 最小修复。发布前fresh检查发现main刚合入#1800，未推分支、未触发中间CI；最终 `1fa3becd…` 再普通合并main `93e9d5e2…`，parents为[c1487ebf,93e9d5e2]，完整保留3个不相交的iOS截图诊断脚本。没有重写父链，没有把 #1788 整支冒充已合。最终相对93e为本方原25路径加3个MCP路径，主线其余69个不相交改动保留。两个生成文件每份仅对 d72 更新 runs/repos 两条 sourceHash，保留243 routes/315 methods及新Factory路由。

前一候选548的正式CI受测源是 [90e6988338d56a5f03b09f7e956adbf7ff4daf20](https://github.com/alexj11324/Mikka/commit/90e6988338d56a5f03b09f7e956adbf7ff4daf20)，tree **56e5616bc48d43654c867cb13ea9c6c4ba393d07**，包含晚合主线#1791。该版本的联合steps.ts原字节保留到新候选。**上一候选1fa3的完整CI已于05:29:57 UTC全部完成，actual checkout为f8864eb83055504ac445e07e8d94a0e8eabedee9，tree与head同为0ecc16…；Native本轮原始预算为396≤414、首对181≤199，独立复算通过。** 当前本地执行环境不可用，新组合没有本地全套测试记录；固定源码/生成输出合同已独立核对，canonical generator已由上一轮正式CI执行`--check`并通过。

M1 `01a6bfb3…` 的实际发布与验收暴露出三类问题：daemon 测试改变 tracked fixture 执行权限，导致 seal 拒绝发布；PostHog 缺少部分收尾 span，且 Coordinator 的返回式拒绝被父 step 记为 OK；原 Native 完整登录窗口为 **473 条 SQL > Web 402**，不满足追加验收。

本 PR 在原两文件 mode 修复上合并已复现的 tracing 修复和 SQL 往返减少。原失败及原始计量窗口保留，不能以单测、局部减少或历史较低样本替代最终生产验收。

## 修改后的行为

- **异步导出收尾：** root span 的现有 `waitUntil` 同时覆盖 batch processor 的待发队列和 exporter 已开始的 transport；Logs 并行 flush。响应不等待遥测，拒绝/同步异常仍被原失败边界包含。
- **真实拒绝可见：** 在返回式工具错误转换之前保留自有 `coordinator.tool` 子 span；七种闭集仓库拒绝在自有 resolve/dispatch span 标记 ERROR 与安全 code，保留原业务返回、权限检查及重试行为。
- **Native 往返减少：** 当前 read batch、实际 DB executor 和 workspace 内共享订阅 policy 观察；after/cron/workflow 任务仍 fresh。一次 SQL 原子消费 enrollment 并发行凭据；无 acknowledgement 的 pending command 读取合并为一次 snapshot。runs/repos 读取用现有 authority helper 在同一 SQL snapshot 检查凭据、当前 owner 和结果，保留初始身份/版本门禁及非空 repo settings 读取。
- **Codex MCP 合同：** `RunContext` 已写入 `MIKKA_DECISION_MCP_TRACEPARENT`，私有 reader 现在允许这个已知键；保留未知键拒绝、私有文件、身份、nonce、大小与NUL检查。采用 #1505 owner [明确开放复用的](https://github.com/alexj11324/Mikka/pull/1752#issuecomment-6732078911) `9ef8cb26…` 中1个reader文件和2个真实producer/writer/wrapper回归文件，不带其余7个timing/Factory文件。空值不会产生出站trace header；wrapper回归不是实际远端header或PostHog摄入证明。
- **诊断与发布：** E2B gate 失败时输出有界、闭集的 source/harness/HTTP trace/workflow/refusal 关联字段；HTTP trace 明确只代表提交请求。两份 daemon fake executable 的 blob 不变、mode 正确为100755。路由生成文件按原 generator 同步 sourceHash，文档说明上述实际合同。

没有 schema/migration、依赖或权限范围变更，没有新增产品 DB 查询、轮询或 prompt/output/message 记录。纯只读 snapshot 的边界、后台 policy 新鲜度和撤权路径有对应回归。

## 已有验证与剩余门禁

| 验证 | 实际结果与边界 |
| --- | --- |
| daemon fixture/seal | 原精确源真实7个adapter测试后仅2个mode变脏，原seal拒绝；仅mode修正后同7项与seal通过。不是生产registry发布证明。 |
| OTLP 与返回式拒绝 | 实际官方 SDK 的在途 exporter 生命周期回归 RED→GREEN；拒绝错误子span的同测试 RED→GREEN。完整原输出保留。 |
| read batch policy | 原 v1 后台 afterJob 继承缓存的真实回归 RED 保留；v2后台新鲜读取及相关38项通过。 |
| 真实 PG A+B | [42551207785](https://github.com/alexj11324/Mikka/actions/runs/42551207785)：相同13项，baseline11 pass/2 fail→candidate13/13，零skip。消费及无receipt读取4→1；并发、回滚、过期、卸载撤权保持。 |
| C 实际 PG与旧失败 | 旧独立 [42553864534](https://github.com/alexj11324/Mikka/actions/runs/42553864534) baseline180秒timeout保留。新 [42556448828](https://github.com/alexj11324/Mikka/actions/runs/42556448828) actual90e中canonical三段 **16+11+5=32/32，零fail/skip**；runs/repos实际均2条SQL，auth后撤销/过期401、移除/外来owner404，原10个围栏并发/strict性能测试保持。A+B新源亦13/13；新CI不能追认旧probe成功。 |
| 前一候选完整 CI（90e） | [42556448828](https://github.com/alexj11324/Mikka/actions/runs/42556448828) 和9个companion全部终态成功；43 checks=36 success+7既有条件skip。PG70个必需套件/3719 tests零fail/skip；Core57 targets、Integration28 targets逐项完成；daemon1569 pass/2个已有skip，新增7个generation回归实际运行。Native原验收与UI strict均success，清理完成；image31条synthetic回复不计生产case。 |
| 本地集成检查 | M1+候选的完整typecheck/lint/runtime lint通过；相关146/146、E2B诊断31/31。完整pnpm check前256项通过，随后8个Unix socket `listen EPERM`，原失败保留。测试类型/lint RED已最小修复；后来仅2个EOF空行与canonical生成8条sourceHash变化。最终本地tree `fb8bad03…` 与合入最新main后的933f是不同受测边界，完整CI实际合成源为90e/tree56e，另含晚合main0e；未改沙箱/路径/版本门禁。 |
| 前一候选 Native 原始预算（90e） | actual90e 首轮原完整登录 **397=19+15+363 ≤ Web412=19+0+393**；首对 startup **170≤204**。12 checkpoints、8 segments、4 totals 的17 operation/78 source桶逐项守恒；root直接对原lifecycle（695452B，SHA `e0185c5197dfb3460a98d1ac7df72ee855745aa76dd38b48bb1e975652c94f6b`）独立复算。完整PKCE/后台和原窗口保留。旧c046 **473>402 RED** 与首对176≤194仍保留，未重跑挑样本；actual tree另含#1791，不把变化全归因本PR。 |
| 上一轮1fa3完整CI（actual f8864eb） | [42564360573](https://github.com/alexj11324/Mikka/actions/runs/42564360573)与9个companion全success；43checks=36success+7原条件skip。PG本轮72套件/3780 Node报告tests、Core57、Integration29均完整通过；daemon1572pass/2既有skip，真实MCP context6与HTTP observation18项执行。Source含canonical generator、typecheck、code/runtime lint全部通过；image隔离31条synthetic回复和6容器/3卷/1网络清理通过。Native及UI strict终态success，不以命名或PR release skip冒充生产。 |
| 上一轮1fa3 Native原始预算 | 实际lifecycle source=f8864eb；完整Native **396=19+15+362≤Web414=19+0+395**，首对 **181≤199**。12checkpoints+8segments+4totals的17operation/78source桶全部守恒，1190个ordinal完整、overflow=false。diagnostics仍incomplete：Native unknown context/statement94/134、Web85/145、bundled53/71、hosted48/76，全部计入原窗口；unknownReadings=0不等于归因unknown=0。原件、独立复算与清理已归档至checkpoint20。 |
| 受控失败/开销 baseline | [42552094175](https://github.com/alexj11324/Mikka/actions/runs/42552094175)绑定旧main1d126：20trace/80span/40ERROR日志完整读回；17条初始未采样仍保留。handler mean +0.345ms、p95 +0.437ms，仅受控本地PG基线，最终修复源待验。 |

前一候选90e的SQL总数和每个query ordinal完整；当轮诊断归因仍为incomplete：Native unknown context/statement为91/135，Web为87/139，历史原值保留。当前f886轮的unknown为上表94/134、85/145，不能混用两轮数据。两轮Native实际installed daemon均为旧已发布`facb389f…`，不能据此宣称新daemon已发布。

CI、Native、正式 Web/daemon/E2B 发布及两条实际 ACME 订阅调用链均有各自 source 边界。下一次合并必须按实际 main writer/账号队列普通 merge；生产还需真实 PostHog 时间线 PNG、Replay 渲染、Logs/generation/notebook 对账及资源收尾。**现在不宣称 #1512 已完成。**

## 历史 main 合流边界（保留原审查记录）

主线现已合入#1788为 **02401458a7fe26e00ce4caa653084c7f9680696d**（tree0013159d…）。相对93e共11路径，其中3个MCP文件与本方blob完全相同；另8路径保留原main内容。独立复核确认只新增startup recorder绑定、Factory工具ID描述及相应测试/fixture修正，未改变本方OTel flush、返回式拒绝span、SQL读取或两fake执行权限。以024为base保留本方25项的精确联合tree已计算为 **fa800b0e41446e7d479473ee3db8e6a1e22e341c**，未移动ref、未执行合并；此联合tree本身尚未全量CI。合并前仍以届时实际main、head、门禁和writer窗口为准。

06:00前后实际main已正常合入#1758为 **88b144d52d091d7ff566c63fce6e902e33edc59e**（tree2d1e3a8e…）。024→88恰5个viewer/Mailpit路径，与own25/28均无交集，全部patch已复核。以88为base保留own25的精确union tree为 **6a30bfd1287a25bb52e61682ea0491d00bb2647d**；远端递归树逐项核对6728个blob，其中本方25项正确、其余6703项与main逐字节及mode保持。仅创建审查对象，没有移动ref、触发重复CI或宣称该联合树已运行。本方尊重#1758当前实际05:52:24–06:52:24发布段及提前释放。

## 合并风险

**Merge risk: high（高，针对当前未吸收凭据范围修正的 c0e head）。**

**Alignment（目标一致性）: good ✅**

- 对齐#1512的完整metadata调用链、异步导出、真实拒绝、发布封存与完整Native预算。pending-dispatch仅修复真实复现的三个snapshot fetcher；其它性能研究未实施。

**Impact（影响范围）: large ⚠️**

- 涉及设备authority、异步读取新鲜度和共享安装入口。当前旧安装器会向依赖lifecycle提供完整job token，包括写权限caller；这是已确认的进程范围问题，未观察到泄漏。
- 30e修正源已发布、正在独立审核但尚未入本PR。实际P0合流还会改变Workspace授权合同，必须保留两侧保护，不能整文件覆盖。

**Verification（验证）: poor ⚠️**

- [Checkpoint26](https://github.com/alexj11324/Mikka/blob/6258f9a410881f3c0f308254cf714d74dd046866/docs/operations/evidence/1512-raw/complete-c0e94d5-20261109/index.safe.json)证明当前c0e全CI与原始Native398≤412、首对181≤206；PG72/3789无skip，75项真实时序与read-batch13已实际执行。
- 这些门禁未覆盖当前凭据进程范围错误，也未证明未来30e/P0/driver联合源。原owner报告scope RED/GREEN，正在取其已有安全receipt；本方新联合源仍需实际执行。
- ACME双订阅、PostHog PNG/Replay/Logs/generation/Notebook及最终源受控失败/额外延迟尚未验收。

**Rollback cost（回滚成本）: low ✅**

- 当前c0e使用普通父链，可正常revert，没有本方新增schema/数据迁移。未来P0联合源的迁移与回滚边界需按实际合流另评。

**Error detection（错误发现）: poor ⚠️**

- 现有CI绿色不能发现依赖lifecycle收到写token的范围错误，不能用HTTP首跳限制或***日志mask替代进程隔离。必须吸收显式默认空输入与caller权限负例，再复核实际执行。
- 原seal、Source/PG/Native、E2B订阅/cleanup门禁和scout保留，失败、未知和历史RED完整封存。

## 可观测性用量与费用（2026-11-09 更新）

截至 **2026-11-09 00:50:44 UTC**，官方 Billing 对项目 `670821` 的 **2026-10-17—11-09 UTC 日级窗口**报告：Logs + Tracing **175 MB**、AI Observability **189 events**、Web Replay **0 recordings**。所属组织仍为 **free**，无有效付费订阅；对应组织产品 cap 为 **10,000 MB / 100,000 events / 5,000 recordings**，本次未修改 plan、cap 或 retention。该窗口末日未完，且账期实际边界为 **2026-10-17 17:45:01.620—11-16 17:45:01.620 UTC**，因此这些日级计量不冒充精确项目账单，也不用于推断峰值需求。当前官方价格：Logs/Tracing 共享每月10 GB免费，超出后10–300 GB档 **$0.25/GB**、300 GB以上 **$0.15/GB**；AI每月10万事件免费，首个付费档 **$0.000350/event**；Web Replay每月5,000条免费，首个付费档 **$0.0050/recording**。来源：[Logs/Tracing](https://posthog.com/logs/pricing)、[AI](https://posthog.com/ai-observability/pricing)、[Replay](https://posthog.com/session-replay/pricing)。

容量估算沿用文档的明确假设：以2026-11-05报告的 **73 MB traces/day** 为旧基线，30天为2.19 GB；若其中10%所代表的既有流量由10%采样改为全量，且流量和每条大小不变，再假设100 runs/day、每run新增25 spans＋10 logs、每条1 KB，则约 **4.27 GB/月**。若该既有流量全部改为全量，则为 **21.9 GB/月（未含新增遥测）**，按公开付费档折合摄入费约 **$2.98/月**；这是场景计算，不是实际需求、当前账单或提额授权。同样，100 runs/day×5次generation仅为 **15,000 generation events/月**，额外 `$ai_*` 事件另计；100条Web录制/day为 **3,000 recordings/月**。PostHog的事件/摄入费与模型提供商费用分开，订阅模式缺少单次收费回执时保留 **unknown**，不以API目录价或零值冒充实际订阅逐次账单。


后续修复和原失败的完整[checkpoint17索引](https://github.com/alexj11324/Mikka/blob/3e2985453d6f3f1f93c718b2abaa9d84ec500724/docs/operations/evidence/1512-raw/followup-548790-20261109/index.safe.json)已远端逐字核对。本轮完整CI/Native的[checkpoint18索引](https://github.com/alexj11324/Mikka/blob/050fbf5a22ec8f7b72229d419ef888d712b46b6a/docs/operations/evidence/1512-raw/ci-548790-20261109/index.safe.json)保留实际合成源、原件、逐项算术与清理。生产调用链仍待实际验收。

#1505 的已授权三文件最小MCP修复已复用到当前候选；来源和精确范围见上文，不降低MCP catalogue门槛。当前ACME正式生产case为0，issue保持打开。

本轮源码发布与首批CI证据已保存至[checkpoint19](https://github.com/alexj11324/Mikka/blob/3555f9d7dfe8383d7a12282dac66bbb2e1e44990/docs/operations/evidence/1512-raw/followup-1fa3-20261109/index.safe.json)。

完整当前源码 CI／Native 已封存为 [checkpoint20](https://github.com/alexj11324/Mikka/blob/fa72b1541911af60898b659d76f0b379c9171afe/docs/operations/evidence/1512-raw/complete-1fa3-20261109/index.safe.json)（58 payload，10,032,855B；索引另计，远端逐字核对）。包含原日志、PG72/3780、原始完整Native396≤Web414和首对181≤199、root独立1190条query ordinal与bucket对账、unknown归因和null/401原记录、workspaceNameCleanup.restored=false的独立边界、历史smoke说明更正、VM停止/删除404及实际生产准备。完整说明见[#1512进度](https://github.com/alexj11324/Mikka/issues/1512#issuecomment-6733342981)。**ACME生产已验收case仍为0；不以本PR自动关闭issue。**
