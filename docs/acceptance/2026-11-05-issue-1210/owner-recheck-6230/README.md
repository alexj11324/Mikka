# #1210 / #1449 — Owner 重新审阅当前交付物

> 审阅记录：共30张真实构建截图，按实际源码版本分列：6230的18图、历史925的6图、当前3f0的6图。当前3f0的134/134源与Happy DOM检查、类型检查、默认构建、UI6截图与审计已有成功原件；root与独立reviewer分别亲阅本轮6图。当前远端产品head为79c；其最终CI、部署与生产六项验收另行核对，不能沿用历史42995的通过结论。

这次修改让仍在 flow v1 验证阶段、或当前交付物尚未接受的 Owner，从已有 Factory 验收入口发起同一候选的重新审阅，再进行独立验证。此前结果保留。既有的接受、退回修改与检查恢复操作继续使用原有组件和权限。

## 当前组合 3f0 / 79c：UI6 与六张增量截图

主线 `3511b3927bc31bf66c52c97545d8ad0d4617c062` 的 #1457 在同一个验收面板加入报告版本绑定的决策区包装。普通 Factory 面板保留 Owner 重新审阅；approval 的底部现在同时显示“退回修改”和“验收”。因此在合并后的精确源码上重新检查该处，而不把历史 925 的界面或 CI 改标为新版本。17 个 Owner 路径中，除面板合并之外的 16 个 blob 与 925 逐字节相等；[源码绑定](increment-3f0/source-binding.json) 记录全部对象与父提交。

| 项目 | 实际结果 |
| --- | --- |
| 实际 checkout / source tree | `3f0daaf76f7c1da346275585bde806a3abd5a8ee` / `277259bbe1cb177abc6bf9866dffabf64fe51e0f` |
| 等树远端产品 head | `79c3731ca819b3304efea0e8f98c936f4b28cd2b`；完整 tree 相同，本地与远端 commit 身份分别记录 |
| 源码与 Happy DOM 检查 | 当前九个测试文件 **134 / 134**；fail / cancelled / skipped / todo 均 0。这不是 PostgreSQL 计数，也不是浏览器测试套件 |
| 类型检查与既有结果复用 | `next typegen`、typecheck 均 exit 0；`flow-view.test.ts` 未重跑，原 7/7 仍绑定 925；此前 133 项 PG 与 29 项 shared-handoff 检查未冒充本轮重跑 |
| 默认 production build | UTC **22:42:08.728098 → 22:44:26.264353**，**137.536398419 秒，exit 0**；最大 child RSS **10,157,500 KiB**，OOM kill **0→0**；[资源原件](increment-3f0/build-resource.json) |
| UI6 环境与来源 | 原隔离 Large 的新一次性 `mikka_owner_ui6_e2e`，正常 setup/bootstrap、租约注册及 session；`http://localhost:3107`；BUILD_ID **`vrJIGEXahx3S4XQF7Ao5C`**，Chrome `157.0.8103.38` |
| 实际过程 | `processes/proc-1793918511021397480-18`，exited / exitCode 0；脚本 UTC **22:41:51–22:44:41**；[过程与环境记录](increment-3f0/runtime-proof.json) |
| 六图时间及尺寸 | UTC **22:44:37.482–22:44:40.948**；六张390×844，三组 pageWidth=viewport=390；[metadata](increment-3f0/review.json) |
| 图片完整性与审计 | 六图及两个 metadata 文件的 SHA256 全部匹配 `files.json`；fixture 与 runner 审计均 passed；UI 包九文件、258,976 bytes，SHA256 `9e8793930f6ae86e26fbb293c6f26695d509a3683d82c187b18845417a6802b6` |
| 自审与独立复核 | [root 的6/6自审](increment-3f0/root-review.json)及[独立6/6逐图报告](increment-3f0/independent-review.md)均通过本次入口/动作呈现复核，无严重度3/4阻断 |
| 原始日志 | [33文件归档](increment-3f0/raw-evidence.tar.gz)，SHA256 `daa256a08a136f70a8fa5b5f4bd357cbde29cc24e6abc8eb0fff7f1120df9749`；[归档模式扫描](increment-3f0/archive-audit.json)无匹配 |
| 清理 | 正常释放租约、删除 UI6 专属数据库，PostgreSQL 明确 `server stopped`。root 的[DELETE响应](increment-3f0/cleanup-delete-response.json)为 `{}`，随后[平台GET读回](increment-3f0/cleanup-readback.json)为 HTTP404 / Sandbox not found，确认该临时资源已删除 |
| 当前 head 的最终 CI | **本页尚未收集 `79c…` 的最终 CI 证明**；由 PR / issue 后续按精确 head 和应用身份记录。下文 `42995…` 的成功只属于历史版本 |

| 状态 | 3f0 的任务入口 | 3f0 的验收面板 |
| --- | --- | --- |
| waiting | ![3f0等待回答入口](increment-3f0/waiting-light-390-entry.png) | ![3f0等待回答面板](increment-3f0/waiting-light-390-pane.png) |
| approval | ![3f0等待确认入口](increment-3f0/approval-light-390-entry.png) | ![3f0等待确认面板](increment-3f0/approval-light-390-pane.png) |
| expired | ![3f0问题过期入口](increment-3f0/expired-light-390-entry.png) | ![3f0问题过期面板](increment-3f0/expired-light-390-pane.png) |

approval 面板中，上方“重新审阅”和后果说明、底部并列的“退回修改”与黑色“验收”主按钮均完整位于首屏，没有重叠或裁切。与 UI5 的同名图逐项计算哈希：只有 approval pane 的字节改变，另外五张完全相同；每张仍有本轮真实采集记录，不把复用 blob 当作没有重新采集。

waiting / expired 的通用“线程”标题、过期夹具仍显示等待状态，以及入口中的既有英文摘要，都保留为呈现限制。这些正常加载后的静态图未点击重新审阅、退回修改或验收；不证明实际 POST、错误恢复、键盘操作、所有 Artifact 版本分支或 ALEX43 的生产六项验收。历史浅深桌面截图仍归属于6230，未改写为3f0重新截图。

## 历史组合 925 / 42995：增量验证与六张图

主线 #1454 在同一验收面板加入 detail 加载/错误门禁，v1 实际可达，因此普通合并后补这一组；#1439 的 v2/spec 窄栏布局不属于 ALEX43。本轮唯一冲突同时保留 Owner 重新审阅 footer 与主线 v2 flow guard/prop。17 个 Owner 路径的有序增删行与原补丁逐项相等，13 个非交叉 blob 字节相同；[源码绑定与逐项对照](increment-925/source-binding.json) 保留精确身份。

| 项目 | 实际结果 |
| --- | --- |
| 本地实际验证 commit / tree | `925245325fbff83ca1bd0579b819c3fcda397b2e` / `8c8415051e6da62f5940a4c6606f4e604e257b70` |
| 等树远端 PR head | `42995b9b1da5c14325fb5c4f7ed04859257e344f`；完整 tree 相同，commit 元数据/父历史身份按对照分别记录 |
| 源码与 Happy DOM 检查 | `test:factory-acceptance-ui` 124 / 124，`flow-view.test.ts` 7 / 7；均 fail/cancelled/skipped/todo=0；不是 PG 计数或浏览器测试套件 |
| 类型检查 | `next typegen`、typecheck 均 exit 0 |
| 默认 production build | UTC 22:21:58.816827 → 22:23:56.768799，117.952321958 秒，exit 0；最大 child RSS 10,101,468 KiB，oom_kill 0→0；[原始资源记录](increment-925/build-resource.json) |
| UI5 环境 | 新隔离Large，Node24.22.2 / pnpm10.34.3 / PostgreSQL17.11；正常bootstrap/browser install均exit0；[原件](increment-925/environment-proof.json) |
| UI5 来源 | `http://localhost:3107`，全新 `mikka_owner_ui5_e2e`，正常 bootstrap 与租约登录；BUILD_ID `5fcoXvNSEGL3A_vkblDOH`，Chrome `157.0.8103.38` |
| 六图时间 | UTC 22:24:08.634 → 22:24:12.031；每张390×844，三组pageWidth=viewport=390；[metadata](increment-925/review.json) |
| 逐图审阅 | root 6 / 6 自审；`prepare_final_ui_increment` 6 / 6 独立复核；均未发现阻断这条入口/动作的视觉问题 |
| 证据与清理 | fixture/runner audit passed；UI包SHA256 `eea7e503eb052fe80f1ad8daa53763b4c08c87f5b715e60a10430c8eeb895247`；整体22:21:41–22:24:12、exit 0，专属UI库删除、PG明确server stopped |
| 原始日志 | [33文件归档](increment-925/raw-evidence.tar.gz)，SHA256 `9b09798e1f7ebebfeb57d1db046db8def1383888dba850bf18b950ab47f0993c`；[归档模式扫描](increment-925/archive-audit.json) 无匹配 |
| 历史 head 42995 的 Git-linked CI | [CI42120382630](https://github.com/alexj11324/Mikka/actions/runs/42120382630)、[SSR42120382928](https://github.com/alexj11324/Mikka/actions/runs/42120382928)、[Browser占位门禁42120382809](https://github.com/alexj11324/Mikka/actions/runs/42120382809) 均success。22:27:21读回17项检查=16success+条件性OIDC skipped，四required均按head/app匹配success；[读回记录](increment-925/ci-42995.json) |

CI 实际检出的是 synthetic merge `f4fd9c09bd3de8c049831d13942ea7b1aa157538` / tree `7f42aa4d11bdc82cc589ca481fcf0023478ac1d7`，parents 为新 main `565c…` + PR head `42995…`。它不等于本地 UI 的 `8c841…`。后续 main 的只读仓库工具广告没有改动此 UI；真实 ALEX43 验收仍须按原六项使用 inspect_artifact 与原问答/命令回执，不能由新增 inspect_repository 替代。

| 状态 | 925 组合的任务入口 | 925 组合的验收面板 |
| --- | --- | --- |
| waiting | ![925等待回答入口](increment-925/waiting-light-390-entry.png) | ![925等待回答面板](increment-925/waiting-light-390-pane.png) |
| approval | ![925等待确认入口](increment-925/approval-light-390-entry.png) | ![925等待确认面板](increment-925/approval-light-390-pane.png) |
| expired | ![925问题过期入口](increment-925/expired-light-390-entry.png) | ![925问题过期面板](increment-925/expired-light-390-pane.png) |

三种状态均正常出现验收入口与重新审阅按钮；approval 同时完整保留独立主验收按钮。approval、expired 两张 pane PNG 与旧 UI4 对应图片逐字节相等。waiting pane 本帧为通用“线程”标题；与 expired 相同，这是已记录的异步标题帧限制。图中未见横溢、遮挡或新增布局阻断，不能将静态截图写成加载失败、键盘操作、重审 POST 或生产模型验收通过。

旧18图继续精确归属于6230/f88，证明其浅深桌面与窄屏状态；没有把旧图改标成新组合。以下历史分版本证据保持原样，未重复运行未受影响的133个PG与29个shared-handoff检查。当时已准备独立证据提交，尚未发布引用；产品源码head为42995。本页此次统一收录历史和当前证据，引用由root后续发布；当前产品head已更新为79c。独立证据提交避免纯证据追加重复全量CI。

## 首轮18图（6230）的版本与证据来源

| 项目 | 精确记录 |
| --- | --- |
| PR | [#1449](https://github.com/alexj11324/Mikka/pull/1449)，Owner recheck |
| 原始远端 Owner head | `d5fec6ebb6b444901ebb3f2f18ceab70fcf66a5e` |
| 本轮验证分支 | `verify/1210-owner-only-81c` |
| 本轮本地源码提交 | `6230e75351a41bfd6c4586166d0718b572380983` |
| 本轮完整源码树 | `f88bdd57e33e703000c9ac1bfccce028c1bb3e14` |
| 等树的远端 source merge | `e8254c39949269d33e7328982392ce4905344e4b`；只创建 Git 对象，截图前未更新 PR ref |
| 已整合主线 | `81c05e18bc087c6a08e1dd23bb323bd3f6e7cf55`，包括 #1445 原生回答来源和 #1444 approved-plan handoff |
| 构建环境 | 同一隔离 Large，Linux；Node.js `24.22.2`、pnpm `10.34.3`、PostgreSQL `17.11` |
| UI origin / DB | `http://localhost:3107`；UI4 使用独立一次性 `mikka_owner_ui4_e2e`，正常 bootstrap 与 `review.json` 一致 |
| production build | 正常 `pnpm exec next build`，exit 0；UTC `2026-11-05T21:33:41.628311` → `21:35:43.220271`，`121.592099931` 秒；UI4 复用同一 build |
| BUILD_ID | `lrEwhvgNnbrYc6ZHalF2l`；`ui-reused-build-id.txt` 与 `review.json` 相同 |
| 构建资源 | `peakChildRssKiB=10032508`（最大子进程 RSS，非整机用量）；`oomKillBefore=0`、`oomKillAfter=0`、`oomKillDelta=0` |
| build 轮原始归档 | `round-6230-build/raw-evidence.tar.gz`，SHA-256 `90f54e2a43987a94c24ff06fe91524ec6ab69cce51b6ba6fbd57b74c90d63d17`；该轮 build 成功、首次 capture 失败的原件保留 |
| 浏览器与截图时间 | Chrome `157.0.8103.38`；UTC `2026-11-05T21:56:32.499Z` → `21:56:46.392Z`，各组时间见 `review.json` |
| 图片包 | 18 PNG + `review.json` + `evidence-audit.json` + `files.json`，共 21 文件、1,580,559 bytes；archive SHA-256 `fb6aa203b1ba7468474cd2f9eaf2fc74d5f13ebb40674831007cd4de6dc2beaf` |
| 完整性与审计 | 独立重算 `files.json` 中 20 个内容文件的 SHA-256，全部相符；fixture 与四份 runner 审计结果均 `passed` |
| owning-agent 自审 | root 18 / 18 原尺寸 PNG，结论与以下独立审阅一致；未发现本次入口/动作的视觉阻断 |
| 逐图独立审阅 | 桌面 12 / 12：`final_integration`；手机 6 / 6：`ui_bootstrap_diagnosis`。两者各自审阅原图，不将分工合写成一个 reviewer 亲阅全部 18 图 |

两个本轮 source merge 的 commit SHA 不同，完整 tree 相同；截图和构建必须记录实际 checkout 的 `6230…`，不能改写成在 `e825…` 上运行。原始 Owner 的 17 个补丁路径 blob 均未改变，且真实 #1449 历史保留。#1448 的缓存实验不在最终树；`next.config.mjs` 保持主线版本。本页和截图应作为后续证据提交叠加在远端 source merge 上，最终 PR head 与 CI 另行记录。

## 原始证据索引

- [构建资源与实际退出](build-resource.json)、[源码/远端等树与原 Owner blob 对照](source-binding.json)。
- [UI4 历史原始日志归档](raw-evidence.tar.gz)：包含分阶段退出、正常账号 HTTP 状态、源码检查与 PostgreSQL 清理。
- [e0 真实 PostgreSQL / 类型 / lint 原始归档](round-e0/raw-evidence.tar.gz)。
- [6230 增量 PostgreSQL 与 production build 原始归档](round-6230-build/raw-evidence.tar.gz)：保留首次 capture 失败，不将整体进程改写为成功。
- [归档内容安全扫描记录](archive-audit.json)：原始归档经私钥、token 前缀、Authorization、Cookie、含密码数据库 URL、JWT 模式扫描，无匹配；该扫描不等同于证明不存在所有未知类型秘密。

## 设计依据与组件复用

按 `docs/design/README.md` 的来源优先级，本轮沿用当前主线已经运行的 flow v1 Factory 验收布局。没有为本次新增动作提供新的已接受 Figma frame，也不把代码里的历史 Figma 注释当成本次新增设计的验收依据。flow v2 的 `FactoryFlowCard` 与 Artifact 验收报告不在这次改动范围。

| 页面部分 | 复用实现 |
| --- | --- |
| 任务中的验收入口 | 既有 `FactoryAcceptanceRow`、`visibleAcceptance` / `candidateCheckState` |
| 验收面板 | 既有 `FactoryAcceptancePanel`、`FactoryAcceptancePane` |
| 当前候选、检查结果与证据 | `CandidateCard`、`ResultLine`、`CriterionEvidence`、`EvidenceViewer` |
| 重新审阅按钮与忙碌状态 | `components/ui/button.tsx` 的 `Button`、既有 `Spinner`、`RefreshCw` |
| 接受与退回 | 既有 `ApprovalBar`、`RejectNote` 分支未被替换；本次 approval 截图实际显示“验收”，不把图片当作所有退回权限分支的证明 |
| 任务页与浅深主题 | 主线任务页、共享中性色 token、现有响应式布局 |

本次没有新增通用组件。新增文案都在 `messages/zh-CN.json` 与 `messages/en.json`。按钮旁的“对当前交付物重新进行审阅和验证，此前结果仍保留。”位于动作 footer，说明同一候选、新检查及旧结果保留这三个直接影响选择的后果；删掉后会丢失按钮本身没有表达的信息。它不是面板标题下的说明副标题。桌面 reviewer 在六张 pane 中、手机 reviewer 在三张 pane 中均确认这段话和按钮完整位于视口内，未被内容区或底部栏遮挡。

## 从 Owner 任务出发的 walkthrough

“修改前”来自 `81c…` 与本轮 source tree 的代码比较，不伪称已取得前后两组运行截图。用户首先在任务正文中的 Factory 验收行查找当前交付物，再打开既有面板；这遵循主线任务页入口惯例和 R-89 的可发现性要求。

| 用户任务 | 修改前 | 修改后与待核对证据 |
| --- | --- | --- |
| 第一次遇到验证等待回答，希望重新检查当前交付物 | `verify / waiting` 没有可见验收入口；Missing，严重度 3 | 桌面 Found，严重度 0：首屏“Factory 验收”卡片及“验证等待你回答”标签清楚；打开后可见“重新审阅”及保留旧结果的后果 |
| 当前交付物已到接受阶段，Owner 发现旧 review 覆盖不足 | 有接受/退回操作，缺少同一候选重新审阅；Missing，严重度 3 | 桌面 Found，严重度 0：“待你确认”入口打开后，灰色“重新审阅”与下方主操作“验收”同时可见，层级不混淆 |
| 原验证问题已过期，但 Owner 仍需重新核对当前交付物 | 过期等待状态仍没有所需入口；Missing，严重度 3 | 桌面 Found，严重度 0：`expired` 夹具真实 Owner GET 返回 capability，入口与重新审阅可达。旧问题仍 `waiting_user` 且 `expiresAt` 已过期。图片不证明旧问题被回答、续接或改写，也不证明新增了过期专属提示 |
| 在浅色/深色桌面找到候选与动作 | 沿用同一主线布局；上述动作缺失 | 桌面 Found，严重度 0：浅深主题的卡片、结果、按钮和 footer 都可读；无新增明显白色细边、重叠或裁切 |
| 在 390px 手机浏览器完成同样查找 | 上述动作缺失 | 手机 reviewer 确认 Found，无严重度 3/4 阻断：三状态入口与 pane 动作完整，approval 主验收独立可见；三组 `layout.pageWidth=390`、`viewport=390` |
| 只查看结果，暂不开始新检查 | 原验收面板为读取操作 | 仅打开入口、查看面板不提交 recheck；本轮截图只执行这些操作 |
| 旧页面的 revision、候选、权限或活动执行已变化 | 不应从旧页面获得新执行授权 | 组件要求 list/detail/ledger/capability 的精确绑定一致；服务端 POST 再验权限和当前状态。图片只覆盖显示，拒绝与并发语义由版本明确的 PostgreSQL 测试证明 |

等待请求、错误、未知响应、权限失效与已有恢复动作仍由现有面板分支处理。18 图不覆盖这些状态的全部交互、键盘遍历或实际 recheck POST；不能把组件复用等同于完成了这些交互验收。

## 三状态、三布局、入口与面板：18 张图

每个状态都有 1440×1000 浅色、1440×1000 深色、390×844 浅色三组。每组先截任务中的入口，再打开现有验收面板截图。共 3 × 3 × 2 = 18 张，全部实际生成且 SHA-256 已核对；不包含手机深色截图。桌面 12 张、手机 6 张分别由两位独立 reviewer 逐图审阅。

### 验证等待回答（waiting）

| 布局 | 任务中的验收入口 | 验收面板 |
| --- | --- | --- |
| 浅色桌面 1440×1000 | ![等待回答：浅色桌面入口](waiting-light-1440-entry.png) | ![等待回答：浅色桌面面板](waiting-light-1440-pane.png) |
| 深色桌面 1440×1000 | ![等待回答：深色桌面入口](waiting-dark-1440-entry.png) | ![等待回答：深色桌面面板](waiting-dark-1440-pane.png) |
| 浅色手机 390×844 | ![等待回答：浅色窄屏入口](waiting-light-390-entry.png) | ![等待回答：浅色窄屏面板](waiting-light-390-pane.png) |

### 等待 Owner 接受（approval）

| 布局 | 任务中的验收入口 | 验收面板 |
| --- | --- | --- |
| 浅色桌面 1440×1000 | ![等待接受：浅色桌面入口](approval-light-1440-entry.png) | ![等待接受：浅色桌面面板](approval-light-1440-pane.png) |
| 深色桌面 1440×1000 | ![等待接受：深色桌面入口](approval-dark-1440-entry.png) | ![等待接受：深色桌面面板](approval-dark-1440-pane.png) |
| 浅色手机 390×844 | ![等待接受：浅色窄屏入口](approval-light-390-entry.png) | ![等待接受：浅色窄屏面板](approval-light-390-pane.png) |

### 验证问题已过期（expired）

| 布局 | 任务中的验收入口 | 验收面板 |
| --- | --- | --- |
| 浅色桌面 1440×1000 | ![问题过期：浅色桌面入口](expired-light-1440-entry.png) | ![问题过期：浅色桌面面板](expired-light-1440-pane.png) |
| 深色桌面 1440×1000 | ![问题过期：深色桌面入口](expired-dark-1440-entry.png) | ![问题过期：深色桌面面板](expired-dark-1440-pane.png) |
| 浅色手机 390×844 | ![问题过期：浅色窄屏入口](expired-light-390-entry.png) | ![问题过期：浅色窄屏面板](expired-light-390-pane.png) |

## 实际截图方法与隔离边界

本轮脚本使用仓库现有 `scripts/test-accounts/session.mjs` 的账户分配与租约，通过正常 email 注册/登录取得真实应用 session，使用 Owner 的 `storageState` 打开本地 production build。先由原 bootstrap 在全新一次性 UI 数据库核验环境身份与 freshness；没有替换认证/权限守卫、伪造 cookie 或跳过 lease 检查。

任务、订阅目录元数据、机器记录及已结束检查由一次性 UI 数据库中的合成业务夹具准备。运行队列/外部运行边界被明确禁止启动；脚本只打开“Factory 验收”，不点击“重新审阅”、接受或退回，不调用外部模型，不启动真实生产运行。模型名称是夹具元数据，不是一次 live subscription 验收。UI4 日志实际记录两名租约账户的 email sign-up、get-session、workspace、Coordinator read 和 `/mikka` landing 全部 HTTP 200；三个 Owner task GET 均 200，最后记录 18 张截图。HTTP 诊断只保留 method/path/status，不收集 cookie、请求体或响应体。

发布的材料只包含截图、无认证内容的版本/布局元数据与扫描结果；密码、cookie、会话文件、数据库连接串和原始网络记录不进入图片包。实际 `evidence-audit.json` 的 fixture 和四个 runner 扫描均 `passed`；扫描对象是当时的 18 PNG 与 `review.json`，随后加入审计和哈希清单。12 张桌面图人工检查未见凭据、cookie 或真实账户联系方式；手机原图由另一 reviewer 审阅。脚本最终按 dirty 释放夹具租约，成功删除本轮一次性 UI DB，并记录 PostgreSQL `server stopped`；整体 exit 0。

## 分版本记录的验证

| 实际源码 | 项目 | 已有实际结果 / 当前状态 |
| --- | --- | --- |
| `e0d1a11fb05798d636439127ef5d16a29d594eaa` / tree `2fae74c0d7414f66d8c8aa8bd48e19623101f124` | `lib/factory/profile-dispatch.db.test.ts` | 113 / 113，通过；0 fail / cancelled / skipped |
| 同一 `e0… / 2fae…` | `lib/factory/questions/execution-continuation.db.test.ts` | 17 / 17，通过；0 fail / cancelled / skipped |
| 同一 `e0… / 2fae…` | `tests/request-query-count.db.test.ts` | 3 / 3，通过；0 fail / cancelled / skipped |
| 同一 `e0… / 2fae…` | typegen、typecheck、lint | 各 exit 0 |
| 同一 `e0… / 2fae…` | UI bootstrap | exit 1：`ENVIRONMENT_DATABASE_NOT_FRESH`；未进入 build，不计为本轮构建失败或成功 |
| `6230e75351a41bfd6c4586166d0718b572380983` / tree `f88bdd57e33e703000c9ac1bfccce028c1bb3e14` | `tests/cloud-runtime-auto.db.test.ts` | 29 / 29，通过；0 fail / cancelled / skipped；全新 `mikka_owner_cross_e2e` 的正常 setup 和后续 drop 均 exit 0 |
| 同一 `6230… / f88…` | 全新 UI DB 正常 setup / bootstrap | `ui-create`、`ui-setup`、`ui-bootstrap-resume` 均 exit 0；bootstrap 返回精确 `6230…` 和本地 origin，freshness guard 未被绕过 |
| 同一 `6230… / f88…` | 默认 production build | exit 0，121.592 秒；详见本页资源记录 |
| 同一 `6230… / f88…` | 首次截图阶段 | `ui-capture` exit 1：`ACCOUNT_INITIALIZATION_FAILED`，发生在账户分配、业务夹具和图片生成之前；原失败日志保留 |
| 同一 `6230… / f88…`、同一 BUILD_ID | UI4 成功截图 | `ui4-capture` exit 0，18 PNG；`ui-evidence-audit`、`ui-package` 均 exit 0，源码前后检查一致，清理 exit 0 |
| 当前产品 PR head `79c…` | Git-linked CI 与 mergeability | 本页尚未收集最终 CI 证明；按 PR / issue 后续精确 head 记录核对，不将历史版本 CI 计为当前通过 |

旧轮三组 PostgreSQL 合计 133 个测试，不能写成在新 `6230…` 上重跑过。#1444 实质交叉是 shared dispatch 的 approved-plan handoff，所以本轮增量运行 `cloud-runtime-auto.db.test.ts`；它并不是专门新增的“Owner 重新审阅且有 spec 历史”用例。原始 Owner 17 个补丁 blob 与 UI blob 都未改变，可按版本关联复用已有证据；最终组合仍以最终 PR CI 为门禁。

旧轮 bootstrap 的原因已确认：前三组数据库测试在原库留下用户记录，随后在同一库首次初始化账户环境，触发 freshness guard。正确恢复使用另外两个全新一次性数据库，分别承载交叉测试与 UI，不删除旧库用户来绕过 guard，不伪造环境 descriptor。此环境恢复不改产品源码。

build 轮进程 `proc-1793914403520338789-26` 于 UTC `21:33:23` 启动，整体 exit 1 来自截图前的账户初始化，不能把那一轮改写成通过，也不能把成功的 build 改写成失败。随后沿用同一构建，将 `next start -H localhost` 与认证/截图 origin `http://localhost:3107` 对齐，正常 landing 返回 200；又修正了外置夹具中一个 SQL 参数同时用于 UUID 和 text 的占位符，未改产品源码或认证守卫。

UI4 成功进程 `proc-1793915778968922370-45` 已实际 exited / exit 0；脚本时间为 UTC `21:56:19` → `21:56:47`。`ui4-source-before.log`、`ui4-source-after.log` 均为空的成功 `git diff --exit-code` 输出，脚本前后分别检查 exact HEAD 和 tree，`ui4-stages.log` 最后为 `complete`。截图沿用原 build，没有再次运行昂贵构建或把此前失败删除。

## 独立桌面视觉复核记录

reviewer 未编写产品 UI，按 `ux-heuristics` 和 `cognitive-walkthrough` 对 12 张原尺寸桌面图片分别审阅。任务限定为“Owner 在当前任务中找到验收入口，打开面板并识别同一候选的重新审阅动作”；不假设已经点击新检查或最终接受。截图内这条可见路径评级 10 / 10，最高严重度 0；没有需要先修复才能完成此路径的可见问题。该评分是专家检查结论，不是用户实验，也不是全产品可用性评分。

| 实际打开的文件 | 具体观察 |
| --- | --- |
| `waiting-light-1440-entry.png` | 任务标题、描述与首屏 Factory 验收卡片构成清楚路径；等待回答标签和右箭头可见 |
| `waiting-light-1440-pane.png` | 右栏已选“验收”；独立结果与 footer 的“重新审阅”完整可见，等待验证没有被显示为已通过 |
| `waiting-dark-1440-entry.png` | 深色卡片与背景能分辨；标题、等待标签、入口箭头清楚，无新增白色描边 |
| `waiting-dark-1440-pane.png` | 深色结果、后果提示与按钮均可读；footer 在底部视口内，无遮挡或重叠 |
| `approval-light-1440-entry.png` | 首屏入口显示“待你确认”，与等待回答状态区分；原有理由两行截断不遮挡状态和箭头 |
| `approval-light-1440-pane.png` | 验收标准、报告入口、独立结果完整；灰色“重新审阅”位于独立的主操作“验收”上方 |
| `approval-dark-1440-entry.png` | 深色中的待确认标签、任务标题和验收卡片可辨认；未见截断覆盖操作 |
| `approval-dark-1440-pane.png` | 灰色重审与浅色主验收按钮层级清楚，证据入口和结果可读，底部按钮没有出屏 |
| `expired-light-1440-entry.png` | 过期夹具仍显示可点击验收入口；标题标识过期夹具，实际状态标签保持“验证等待你回答” |
| `expired-light-1440-pane.png` | 入口打开后，重新审阅与保留旧结果提示完整可见；未将过期问题伪装为已回答或已通过 |
| `expired-dark-1440-entry.png` | 深色过期夹具入口、等待状态和导航箭头均可辨认；与浅色结构一致 |
| `expired-dark-1440-pane.png` | 深色 footer 可见，按钮无裁切，结果没有新增重叠；与等待状态采用同一主线布局 |

“问题已过期”来自夹具任务标题；现有状态标签仍显示“验证等待你回答”，结果行仍沿用“进行中”。因此这组图片证明过期问题存在时 Owner 仍能找到同候选重审入口，不证明 UI 已新增过期专属状态文案。截图中的英文线程名称与理由是原有宿主/夹具内容，不能用它们宣称全屏所有内容已做新的国际化整理。

按认知 walkthrough 的四问：Owner 能从任务中的验收块判断下一步；能看到卡片和箭头；打开后“重新审阅”及直接后果说明与目标相符；entry/pane 成对截图证明打开后的反馈清楚。重新审阅 POST、最终接受、错误恢复、键盘焦点和关闭返回行为不属于这些静态图片的完成证明。

### 另一 reviewer 的六张手机复核

`ui_bootstrap_diagnosis` 独立查看了以下全部 390×844 原图，并核对 PNG 尺寸、哈希与三组布局元数据。这里汇总其报告，桌面 reviewer 未将这些结论冒充自己的逐图观察。

| 手机文件 | 独立报告的观察 |
| --- | --- |
| `waiting-light-390-entry.png` | 入口与等待状态可见，无横向溢出或遮挡 |
| `waiting-light-390-pane.png` | 重新审阅按钮及保留旧结果说明完整在首屏底部 |
| `approval-light-390-entry.png` | 待确认入口可见，文字截断不覆盖动作 |
| `approval-light-390-pane.png` | 重新审阅与黑色“验收”主按钮分别可见，底部操作没有重叠 |
| `expired-light-390-entry.png` | 过期夹具的验收入口仍可达，未见横向溢出 |
| `expired-light-390-pane.png` | 后果提示和重新审阅完整可见；顶栏此帧显示既有“线程”fallback，状态仍为等待回答/进行中 |

手机 reviewer 未发现高严重度阻断。它同时指出一项截图局限：`expired` pane 的线程标题尚未完整载入。源码 `IssueThreadPanel` 使用 `listedName || detail?.name || t('title')` 的既有异步 fallback，采集只等待重新审阅按钮可见；因此不能据单帧宣称候选名称存在持久回归，也不能把该帧当作最终标题完整加载的证明。桌面 waiting/expired pane 同样可见通用“线程”标题，任务主标题仍留在旁边；本页保留这一观察，不将它隐藏为完整标题验收。

| 检查 | 当前结论 |
| --- | --- |
| 18 PNG 齐全、尺寸与 `review.json` 匹配，所有截图同一 BUILD_ID / checkout | 通过完整性检查：12 张 1440×1000、6 张 390×844；20 个内容文件哈希全部匹配 |
| R-89：三种状态的主入口可见，打开后能找到同候选重新审阅 | 桌面通过：三状态浅深主题均在首屏显示入口，六张 pane 均可见动作 |
| R-90：复用主线验收组件与共享 Button，没有重画近似组件 | 源码及桌面截图通过；没有新增通用组件 |
| R-40 / C-04 / C-08：后果提示有必要信息，且不替代具体按钮或状态 | 桌面通过：提示紧邻 footer 动作，说明同一候选与保留历史，不是标题副文案 |
| R-30 / R-31 / R-32 / R-33 / R-34：中性色、暗色边界、字级、圆角与状态可读性 | 桌面视觉通过，未见新增白色细边、重叠或裁切；不声称做了数值 WCAG 对比度测量 |
| R-84 / R-85 / R-86：沿用既有线程/交付物入口，不新增任务页问答框 | 本改动可见范围通过：使用既有验收面板，报告入口在验收面板，任务上没有新增问答输入框；未展开线程对话作额外验收 |
| R-87 / R-88：状态可辨认，主操作区的密度与有效面积合理 | 桌面通过：文字和状态颜色可辨，验收与重审层级清楚；稀疏的等待结果不妨碍 footer 操作 |
| 页面横向溢出 | 九组布局记录均 `pageWidth ≤ viewport`；桌面 1430 / 1440，手机 390 / 390 |
| 390px：动作 footer 可见、文字无裁切，触屏目标沿用共享 Button | 手机 reviewer 视觉通过：三状态 footer 完整，approval 两类动作分明；没有把静态截图当作实际触屏/键盘行为测试 |
| 首轮 Owner walkthrough 评级与未解决问题 | 桌面查找/打开/识别动作：Found，严重度 0；手机报告同样无严重度 3/4 阻断。通用线程标题的单帧加载局限已记录；实际提交另行验证 |

## 与生产验收的关系

本页只证明指定版本在隔离环境中的 UI 入口与布局，以及另行列明的源码/数据库检查。合成夹具内的“通过”结果不证明 ALEX-43 的生产六项验收，也不证明真实独立 review/verify 已运行、已回答历史问题或已完成新检查。生产真实任务、订阅运行、来源与候选绑定、六项证据和最终 Owner 回执由 #1210 的后续生产验收记录单独证明。

截至本稿，三轮30张截图分别保留实际源码身份；最新3f0的源/Happy DOM检查、类型检查、构建、UI6审计、自审和独立逐图复核已有成功原件。当前产品head79c的最终CI由PR/issue后续记录，历史42995的CI结果不作替代。部署和生产六项验收仍须真实记录确认，不能从本页推断完成。
