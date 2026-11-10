# Issue #1296：移动端 UI、可用性与 Motion 审计及回归记录

> 本文保留当次版本的三路模型证据与失败。现行验收使用共享 SMOKE 账号，
> 官方 Claude Code 与 Codex 两条订阅路径独立记录。DeepSeek/API-key 路径
> 已退出合并及验收门槛，后续执行按 [验收指南](../acceptance.md)。

- 日期：2026-11-05。
- 跟踪：[Mikka #1296](https://github.com/alexj11324/Mikka/issues/1296)。本文件记录本轮实现和证据，不修改 `AGENTS.md`、`docs/acceptance.md` 或现有合并/验收规则。
- 状态：**合并前审计与 Docker 回归记录；最终发布结果记录在 Issue #1296 正文。** 没有把源码检查、单测、Expo Web 或既往 OTA 当作本次原生安装和生产验收。
- 基线：`a18d22a9d4b6b067297a72eb37205493be4f0b2b`；工作分支：`fix/1296-mobile-usability-motion`。下述本地回归针对该基线上的 Docker 工作树。已整合 main `514030294dcdc68b2d9ca4a977ce04b298b37e6f`，保留上游 Agent Profiles、发布脚本、组件目录与 package.json 的其它变更；最新 no-new-polling 规则也已核对，本轮未新增周期数据轮询；最终 PR head、CI、merge 和发布结果在 Issue 正文记录。

## 1. 环境、判据和证据边界

| 项目 | 本轮记录 |
| --- | --- |
| 执行环境 | Docker Cloud Sandbox Large，8 vCPU / 16 GiB；通过既有授权 API 路径使用，未回退 Vercel Sandbox |
| 运行时 | Node 24.22.2、pnpm 10.34.3；隔离 PostgreSQL 17，loopback 数据库 `mikka_e2e` |
| 应用链路 | Expo 8081 + 真实 Next API 3000，经同源 8080 代理；使用既有测试身份分配/lease 机制取得合法会话 |
| 被测 origin | `https://8080-001m6mjh8at15tpaxcxdmscetmz.sbx.sandboxes-cloud.docker.com`；这是临时隔离环境，停机后失效，不是生产 origin |
| 已有真实浏览器记录 | 375×812 的群聊、抽屉及表单操作；393 的深色样式和新建Bot操作；430宽深色搜索/任务失败恢复截图。完整视口及入口截图清单由 owner 追加，不将局部检查写成全量通过 |
| 截图/日志持久化目录 | 下方证据表给出已落盘截图与检查记录；没有单独保存的 AX 观察以本报告的具体测量为依据，不冒充完整原始日志 |
| 原生运行能力 | 当前执行面没有 iPhone、iOS 模拟器或已安装本次版本的 TestFlight 设备；原生专有项目尚未验收 |
| 沙盒清理 | 本报告写入时仍用于本轮开发/回归。最终停止时间与资源状态待 owner 结束工作后追加；没有预先声称已停止 |

采用 [Nielsen 10 条可用性原则](https://www.nngroup.com/articles/ten-usability-heuristics/) 与 [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/)，重点包括 [Motion](https://developer.apple.com/design/human-interface-guidelines/motion)、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)、导航、布局、字体、颜色、反馈和手势。项目设计依据依次遵循 `docs/design/README.md`、已接受的决定、词汇表和当前实现；归档 Figma 不用于强制重设计。

本报告使用以下证据等级：**源码确认**表示可以指出实际失败机制；**单测通过**表示相应逻辑用例通过；**Web 实测通过**只覆盖明确记录的浏览器场景；**待验收**表示尚无相应运行证据。分数为场景内发生可能性与影响各 1–10 的审计判断，不是线上发生率统计；优先级结合影响判定，不由分数机械转换。相同根因在 UX 表与新增表交叉引用，不重复计数。

### 已归档证据

| 证据 | 范围 |
| --- | --- |
| [历史前插失败截图](issue-1296-evidence/before-group-history-jump-375.jpg) | 第一版实际跳到底的失败，375×812 |
| [历史锚点修复后](issue-1296-evidence/group-history-anchor-375.jpg) | 最终版本载入001–047后，048文字仍在y167；375×812 |
| [模型菜单与服务状态](issue-1296-evidence/model-menu-accessible-375.jpg) | 已选模型、可关闭菜单、未启用服务和保留草稿；375×812 |
| [新建Bot最终表单](issue-1296-evidence/new-bot-form-393.jpg) | 形状3+3、猫/橙色已选、空名创建禁用；393×852 |
| [深色搜索最终布局](issue-1296-evidence/search-dark-430.jpg) | 名称搜索、12px顶栏间距；430×932 |
| [任务真实API失败](issue-1296-evidence/task-error-dark-430.jpg) · [恢复后](issue-1296-evidence/task-recovered-dark-430.jpg) | 停止隔离API后显示失败/重试，重启后轮询自动恢复空态；430×932 |
| [检查结果与源码SHA-256](issue-1296-evidence/verification.json) | 最终02:14 UTC检查、145 tests、环境及各源码文件哈希；不包含密钥或会话 |

所有截图均为真实Expo Web页面。测试消息明确标记为fixture，不代表模型回复；截图不是iOS真机证据。截图的正文说明可与第5节DOM/AX测量及相应源码交叉核验。

## 2. UX-01 至 UX-18 结论

| ID | 结论与处理 | 验证及未覆盖部分 | 主要源码/证据 |
| --- | --- | --- | --- |
| UX-01 | 确认抽屉关闭 spring 与目标导航同 tick 叠加。选目标页时先取消动画并收敛关闭状态，再 push；普通开合保留既有交互 | Web 抽屉打开/关闭、设置导航及返回无残留已记录；原生 push、interactive pop 的空间连续性待设备验证 | `apps/mobile/components/Drawer.tsx`；E-WEB-01；发生 7 × 影响 6，P1 |
| UX-02 | 确认 Bot 聊天内容尺寸变化会强制到底。改用共享底部跟随状态；阅读历史时保持位置，显式“回到最新”恢复跟随 | 逻辑单测及个人Bot真实45秒轮询追加通过：scrollTop保持1598，内容高6290→6398，可视高752，新消息进入AX。图片加载导致尺寸变化的独立场景仍待补证 | `ChatScreen.tsx`、`lib/useChatScroll.ts`、`lib/chat-scroll.ts`、`ChatScrollToLatest.tsx`、`ChatScrollView(.web).tsx`；发生 9 × 影响 8，P1 |
| UX-03 | 确认群聊无条件到底。采用同一底部跟随与历史位置机制 | 群历史前插和离底部追加均 Web 实测通过，保留第一版失败及随后修复过程；见第 5 节 | `app/groups/[id].tsx` 与共享滚动组件；E-WEB-02；发生 9 × 影响 8，P1 |
| UX-04 | 保留现有左滑时间与右滑引用的两套驱动，修正阈值、取消复位与引用成功条件；没有进行全量手势引擎迁移 | 源码已修；原生边缘返回、惯性与手指跟随尚未实测。不能仅因使用两套 API 就宣布全部手势缺陷或已统一驱动 | `components/chat.tsx`；发生 6 × 影响 7，P1 |
| UX-05 | 补共享 Reduce Motion 偏好：原生查询/变化监听与 Web matchMedia；循环 spinner/pulse 和时间弹回在减少动态效果下停止/归稳；抽屉和引用装饰收敛 | 两个偏好行为单测通过。原有 Reanimated spring 默认已有 System 行为，本轮补的是其它动画与统一偏好边界；原生舒适性待验收 | `lib/reduced-motion.ts`、`icons.tsx`、`chat.tsx`、`Drawer.tsx`；发生 8 × 影响 7，P1 |
| UX-06 | 没有证据支持把正常抽屉位移全部移除；保留功能性跟手位移，只处理目标导航叠加及 Reduce Motion 下的装饰视差 | 作为设计约束和 UX-01/05 的去重处理。Web 的 instant-panels 决定不直接套到 iOS；正常原生动效仍待设备评价 | `Drawer.tsx`、设计决定；P2，未新增独立“全部动画过度”缺陷 |
| UX-07 | 确认缓存隐藏更新失败、ChatList 丢弃群列表错误、首次读取失败后前台恢复不足。保留可用旧数据并显示必要的读取状态与重试；恢复/在途请求/路径和 workspace 隔离补齐 | 读取状态单测通过；真实停隔离Next API时chat/home/search保留旧内容并提示更新失败，首次Tasks显示读取失败；API恢复后正常轮询自动恢复。设备断网及前后台切换是另行验收项 | `lib/useApi.ts`、`lib/api-read-state.ts`、`ChatList.tsx`、`ReadNotice.tsx` 与各消费页面；发生 7 × 影响 7，P1 |
| UX-08 | 确认群聊只有最近 100 条，缺少更早历史入口。增加 before 分页、去重/排序和前插位置保持；轮询保留已载入历史 | 真实隔离 API 返回 100 + 45 条、合计 145 条唯一消息；Web 能读到更早记录且锚点保持，见 E-WEB-02 | `app/groups/[id].tsx`、`lib/group-history.ts`、共享滚动组件；发生 10 × 影响 8，P1 |
| UX-09 | 按 Bot/群名称匹配符合既有设计，不把未实现全文搜索判为缺陷。修复独立的 Web 搜索框缺失，并明确“搜索 Bot 和群聊”；加载/错误与无匹配区分 | 源码与类型检查通过；搜索读取失败已有真实API停机记录。430深色最终实测tab bottom64、searchbox top76，相距12px且无重叠；截图已同步，见E-WEB-10。有/无匹配的完整状态仍按实际记录追加，未扩展搜索范围 | `NavBar.tsx`、`app/(tabs)/search/index.tsx`、`ChatList.tsx`；名称限定为设计约束；Web 入口故障发生 10 × 影响 6，P1 |
| UX-10 | 创建按钮具备空值/成员条件禁用与 busy；提交中锁定相关表单，失败保留输入；新群读取失败可重试；移除 create 成功后额外的 router.back | 393新Bot空名禁用、创建中锁定相关控件并显示创建中，成功进入对应聊天。375新群空表单/仅填名不选成员禁用，选择成员后成功创建并返回首页看到新群；两条创建路径均无新增POP_TO_TOP，见E-WEB-03/10 | `new-bot.tsx`、`new-group.tsx`、`NavBar.tsx`、`ui.tsx`；发生 7 × 影响 6，P1/P2 |
| UX-11 | `light` 与已接受的跟随系统决定冲突，配置改为 `automatic`；保留 iOS 系统动态色 | 393 深色 Web 真实 CSS 已核验；这是原生配置变化，需要兼容新 binary。Web 深色不能作为 iOS 已跟随系统的证明 | `app.json`、`lib/theme.ts`；E-WEB-04；发生 10 × 影响 6，P1 |
| UX-12 | 发送/停止、色板、卡片动作、引用取消、附件动作、复制/更多/回应的实体目标提高到至少 44pt，去除会重叠的额外 hitSlop；回应内部视觉 chip 可保持 28pt | 源码尺寸与布局检查；具体浏览器目标测量及真实 iOS 触控仍按记录分别验收，不把视觉 28pt 等同热区 28pt | `chat.tsx`、`ui.tsx`、`cards.tsx`、`new-bot.tsx`；发生 8 × 影响 6，P1/P2 |
| UX-13 | 修改范围内统一 pressed、disabled、busy 和选中语义；复制/更多/回应补按下反馈，卡片/圆按钮禁用与繁忙一致；保留原生 menu/sheet | 通知保存过程中禁用和“正在关闭”有 Web 实测；其余按组件源代码/后续 DOM 回归记录。未声称全 app 触觉反馈已实测 | `chat.tsx`、`ui.tsx`、`cards.tsx`、`settings.tsx`、`SignIn.tsx`；E-WEB-05；P2 |
| UX-14 | 补登录名称、中文形状/颜色、radio/checkbox、Switch 名称、状态读出、焦点可见和 Drawer 模态隔离；改善 Web 小字对比度与可增高布局 | Drawer 焦点/AX、通知 Switch 已实测。后续实测又发现 RN Web 未把 radio 的 accessibilityState.checked 写入 DOM，已单独登记 N-12，显式 Web ARIA 修复及复测不能省略；VoiceOver/Dynamic Type 原生待验收 | `SignIn.tsx`、`new-bot.tsx`、`new-group.tsx`、`settings.tsx`、`ui.tsx`、`theme.ts`、`Drawer.tsx`、`chat.tsx`；E-WEB-01/03/04/05/06 |
| UX-15 | 修正移动端说明、真实路由、系统外观与发布边界；Figma 268:4750 标为归档，358:9186 仍是待核验参考，当前 main 与接受的决定优先 | 文档修正完成；未读取归档稿强制重设计，未宣称未核对的 Figma 已被接受 | `docs/design/mobile.md`、`apps/mobile/README.md`、`docs/design/components.md`；P2 |
| UX-16 | 群聊/成员/回应/历史及其它读取页面用统一 ReadNotice；离线、未发送、停止失败有可发现状态和重试；保留草稿 | 代码与mobile测试通过；真实API停机/恢复见E-WEB-08。群聊stop/发送失败的独立恢复和设备离线仍需补证，不能把存在重试按钮视为全部恢复通过 | `app/groups/[id].tsx`、`ReadNotice.tsx`、`OfflineBanner.tsx`、`StopFailed.tsx` 与消费页面；发生 7 × 影响 7，P1 |
| UX-17 | 消息增加可见操作入口、时间读屏名称与 quote/time accessibilityActions，避免功能只靠隐藏手势；不把整条 Markdown 包成吞掉链接的单一可访问节点 | Web可见消息操作→回复→群聊引用→取消引用已实测通过，消息页关闭也正常，见E-WEB-09；原生VoiceOver替代路径仍待设备 | `components/chat.tsx`；发生 7 × 影响 8，P1/P2 |
| UX-18 | Web 模型菜单原来是只读文字，改成可操作菜单；iOS 保持原生菜单；不可用/检查中状态明确；读写竞态、重复提交、失败回滚/重试与 context 隔离补齐 | 模型读/视图/写入单测通过；真实API停机期间选择失败保留原模型并显示具体错误/重试。隔离账户读取200但无已配置key/subscription/device/daemon；三条真实模型调用未执行。radio DOM问题与N-12共用根因 | `ModelMenu.tsx`、`ModelMenu.ios.tsx`、`ModelNotice.tsx`、`lib/model-menu*.ts`；发生 10 × 影响 8（Web 无法选择），P1 |

上表使用的短路径均以 `apps/mobile/` 为根。类型检查、已通过的算法单测以及 Group 的 Web 实测不互相替代；待设备或真实提供商的条目仍保留限制。

## 3. 本轮额外发现与处置

| ID / 关联 | 页面与操作步骤 | 期望 / 实际及证据等级 | 根因与处置 | 发生 × 影响；优先级 | 证据路径或记录 |
| --- | --- | --- | --- | --- | --- |
| N-01 / UX-14 | 375 登录页，通过 AX 查找邮箱和密码输入 | 应有稳定名称；实际初版 AX 无名称，属于真实 Web 发现 | 只有 placeholder，无明确可访问名称。补标签、登录来源 busy、错误 alert、空值 keyboard-submit guard 和可滚动表单 | 9 × 7 = 63；P1 | `components/SignIn.tsx`；E-WEB-03；截图待 owner 补 |
| N-02 / UX-09 | 打开 Web 搜索 tab，尝试输入名称 | 应能输入；实际 NavBar 的 Web 分支未渲染 search 参数，源码确认 | 增加 Web searchbox，保留 iOS 系统搜索；明确匹配范围，失败/加载不显示“无结果” | 10 × 6 = 60；P1 | `components/NavBar.tsx`、`app/(tabs)/search/index.tsx`；源码/类型检查；Web 截图待补 |
| N-03 / UX-10 | 创建 Bot 成功并进入聊天 | 应一次导航到新聊天；实际出现 POP_TO_TOP was not handled 红条/警告，真实 Web 发现 | 页面 router.back 与 openChat 内部栈操作重复；创建页只调用 openChat，公共导航由 owner 统一核对 | 8 × 5 = 40；P1 | `app/new-bot.tsx`、`app/new-group.tsx`、`lib/navigate.ts`；E-WEB-03；最终导航截图待补 |
| N-04 / UX-02/03/08 | 已有 100 条群消息时读 046，再载入更早 45 条 | 应保留锚点；第一版 helper 单测通过后，真实 Web 仍跳到底，046 从 y167 到 y-18023 | 安装库在 Web 的原生事件注册没有把真实 scroll 事件送给 JS；新增 ChatScrollView 平台适配，Web 直接 RN ScrollView，原生保留 KeyboardChatScrollView。后续锚点/追加实测通过，不另把它统计为三个缺陷 | 10 × 8 = 80；P1 | `components/ChatScrollView.tsx`、`.web.tsx`、`lib/useChatScroll.ts`；E-WEB-02 |
| N-05 / UX-01/14 | Web 首次打开 Drawer；关闭后查 AX；打开后键盘导航 | 应打开无错误，关闭项不可访问、模态内焦点闭环；首次打开出现 BackHandler 红条；关闭/打开语义存在源码缺口 | BackHandler 仅非 Web 注册；关闭用 a11y hidden + inert，打开屏蔽底层，Tab/Escape/焦点恢复明确。root 复测红条消失及焦点闭环通过 | 9 × 7 = 63；P1 | `components/Drawer.tsx`；E-WEB-01 |
| N-06 / 图像 | 显示带相对头像路径的 profile/Drawer | 应加载默认/用户头像或稳定后备；实际头像空白，真实 Web 发现 | 产品侧相对 URI 要按 API_URL 解析，Drawer 复用 settings Avatar 并有加载失败后备。隔离代理漏转静态资源是另一项环境原因，单独修复，不能全部归为产品缺陷 | 7 × 4 = 28；P2 | `components/settings.tsx`、`Drawer.tsx`；E-WEB-07；代理配置为环境记录，不入产品业务修复统计 |
| N-07 / UX-14 | 新建 Bot 后用 AX 识别形状/颜色 | 应读中文名字和选中状态；实际读出 cercle/encre 等内部值，颜色旧目标 40pt，真实 Web 发现 | 使用与中文词表一致的标签，radio/checked、44pt 目标和动态高对比选中环；Web 还需 N-12 显式 ARIA，不能只凭源码 state 记通过 | 10 × 6 = 60；P1 | `app/new-bot.tsx`；E-WEB-03/06 |
| N-08 / UX-14 | 阅读浅色页面/分组底上的小号次要和错误文字 | 应达到小字 4.5:1；实际 alpha 合成后 secondary 为 3.44/3.30，danger 为 3.55/3.18；属于可重复计算的源码发现 | Web secondary alpha .75、浅色 danger #D70015；新“回到最新”和模型菜单小字使用 text。iOS 系统动态色保留，原生对比度待测 | 9 × 5 = 45；P1 | `lib/theme.ts`、`ChatScrollToLatest.tsx`、`ModelMenu.tsx`；E-COLOR-01 |
| N-09 / 表单 | 设置资料把名字清空并保存，再恢复原名 | 应有可恢复校验且旧错误随有效输入消失；root 已记录“请输入名字”以及恢复原名后清错误的回归结果 | 资料表单明确空名校验与错误恢复；提交中的操作受 guard/禁用保护；记忆摘要等同类写入复用防重复状态 | 7 × 4 = 28；P2 | `app/settings/profile.tsx`、`memory-summary.tsx`；E-WEB-03 |
| N-10 / 回应 | 读取超过 100 条历史的回应；模拟保存失败/重复按回应 | 应覆盖已载入历史，失败回滚并可重试；源码显示单次回应读取有 100 条边界，保存只有 finally 的路径会留假乐观态或抛未处理拒绝 | 群回应按批读取并保留过渡快照；两类聊天有写 guard、失败回滚及明确重试。分批/合并单测通过，真实失败网络注入待补 | 6 × 6 = 36；P2 | `lib/group-history.ts`、`ChatScreen.tsx`、`app/groups/[id].tsx`、`tests/group-history.test.mts`；E-TEST-01 |
| N-11 / UX-07 | 首次请求失败后让应用回前台；首页群列表读取失败 | 应立即恢复读取且错误可见；源码 loadedAt=0 路径不触发前台恢复，首页还丢弃 groups.error | 读状态 helper、同源在途合并/旧响应失效以及列表错误透传，统一 ReadNotice 保留旧数据。与 UX-07 同根因去重 | 7 × 7 = 49；P1 | `lib/api-read-state.ts`、`lib/useApi.ts`、`ChatList.tsx`；对应 2 个 helper 测试；真实弱网回归待补 |
| N-12 / UX-14/18 | 打开模型菜单，检查视觉已选 radio 的真实 DOM/AX | 应有 aria-checked=true；实际视觉有勾，但 aria-checked=null、AX Value=0，root 真实 Web 发现 | 当前RN Web未将这些accessibilityState属性映射到DOM。radio/checkbox显式aria-checked，按钮显式aria-busy/aria-disabled，tab显式aria-selected，同时保留native state；普通Switch已正常，不重复改。新Bot猫/橙色、群成员及ModelMenu已实测checked=true/AX1；插件应用/技能原来AX均0，修复后切换时选中项AX1、另一项AX0，目标高44。线程筛选菜单四项完整，选择进行中后badge与menu radio AX1正确，恢复全部正常 | 10 × 7 = 70；P1 | `ModelMenu.tsx`、`new-bot.tsx`、`new-group.tsx`、`settings.tsx`、`Segmented.tsx`、`ui.tsx`、`cards.tsx`；E-WEB-06/10 |
| N-13 / UX-18/16 | 在真实 API 返回聊天 enabled=false 时保留草稿并尝试发送 | 应解释不可用状态并禁止发送，同时仍能阅读、编辑草稿和检查模型；本轮发现不能把不可用状态仅留在服务端字段 | coordinatorEnabled=false表示此部署暂不运行回复（部署/AI Gateway条件），与模型available不同，后端仍可接收事件到inbox。UI不改后端gate：ChatScreen显示服务未启用及GET重试，Composer sendDisabled只禁发送，不锁输入/附件/模型或stop。说明已实测显示；输入草稿后点击状态重试，草稿保留且发送disabled=true/aria-disabled=true，没有发模型请求；附件/stop独立操作仍按各自场景验收 | 8 × 6 = 48；P1 | `ChatScreen.tsx`、`components/ui.tsx`；E-MODEL-01；不等于模型调用成功 |
| N-14 / Web导航 | 430深色打开Search根tab；首页Drawer进入插件页后返回 | 浮动tab遮盖重复标题、根页出现多余返回；初修后仍与搜索框重叠4px。插件页另实测缺返回按钮，Web canGoBack读取不具响应性 | Web tab根隐藏重复标题/默认Back、保留显式left与44pt占位，并增加16px间距；最终tab bottom64/searchbox top76，间隔12px。Web非tab根无自定义left时始终显示Back，点击时无历史则replace到/chats；插件返回已实测出现。iOS/Android既有导航不变 | 9 × 5 = 45；P2 | `components/NavBar.tsx`；E-WEB-10；最终430截图已同步，待owner归档 |
| N-15 / 低影响布局 | 393新建Bot查看六个形状 | 目标60×60均可操作，但原网格排成5+1，最后一项孤立 | 只将形状组现有容器限制为3×60+2×12=204pt并居中，形成3+3；目标尺寸、原生语义与事件不变 | 10 × 1 = 10；P3，未作为阻塞门禁 | `app/new-bot.tsx`；E-WEB-10；393最终实测3+3、60×60，截图已同步，待owner归档 |
| N-16 / UX-07 | 已有线程缓存后刷新读取失败 | 应提示上次状态与重试；源码只在无data时显示失败会隐藏陈旧状态 | 线程详情用ReadNotice(error,hasData,label线程,reload)，页头标记“上次状态”；源码机制确认，未执行真实线程500注入 | 5 × 6 = 30；P2 | `app/thread/[id].tsx`；源码/整合typecheck |
| N-17 / 审批状态 | 批准动作成功，但随后的列表刷新失败仍返回旧items | 旧卡不应再次提供批准；源码会重现可按批准入口。没有声称真实邮件/日历已重复写入 | PendingActions按id保留done/failed/declined/409终态回执，同步inFlight与settled guard；服务刷新失败不能复活旧动作 | 5 × 7 = 35；P1 | `components/PendingActions.tsx`、`tests/pending-actions.test.mts` 5/5；API宿主mock |
| N-18 / 附件导航 | 打开系统picker后离开附件页，等待异步选择完成 | 迟到结果不应返回/关闭新的页面；源码完成后无条件router.back可pop错误页面 | mounted/focused/focusVersion guard、single-flight、busy及可见失败恢复；不替换系统picker；Web关闭入口另见N-21 | 4 × 6 = 24；P2 | `app/attach.tsx`、`tests/attach-sheet.test.mts` 5/5；系统宿主mock，原生picker未验收 |
| N-19 / OpenUI问答 | 单题同时有options与allowCustom，选择之外输入自定义答案 | 应能补充自定义答案；快速options分支吞掉输入，现有welcome schema可达 | options快速分支增加!allowCustom；允许自定义时复用已有完整表单，不重建问卷 | 8 × 6 = 48；P1 | `components/OpenUI.tsx`、`tests/openui-questions.test.mts` 3/3；组件测试非live模型 |
| N-20 / Web主流程入口 | 在Web主页连续两次点击“新建”；检查更多/筛选菜单 | 应看到全部items；实际直接进入new-bot，“新建群聊”永远不可达，root真实点击与源码一致 | webItem只调用item.onOpen，忽略items。Web改用可关闭菜单，复用Modal/Row/Group/CloseButton，列出全部项与on状态，恢复焦点；native菜单原样，未在顶栏硬铺两个按钮 | 10 × 8 = 80；P1 | `components/NavBar.tsx`、`WebBarMenu.tsx`；E-WEB-10：375全部创建项、Escape回焦点、新群创建/返回以及线程筛选均实测通过 |
| N-21 / Web取消入口 | 打开/attach或/message表单sheet后取消 | 原生formSheet有系统关闭方式，Web没有对应系统交互；实际Web两页缺显式关闭入口 | 两页仅Web分支复用44pt CloseButton，native布局不变；/attach和/message关闭均实测44×44且返回成功。附件返回保留群聊草稿；消息返回保留后续返回时的搜索查询，回复/引用/取消引用通过。迟到picker结果guard另有mock用例 | 8 × 5 = 40；P2 | `app/attach.tsx`、`app/message.tsx`；E-WEB-09；不声称系统原生picker通过 |

### 新增发现对应的评审原则

| 发现 | Nielsen | HIG重点 |
| --- | --- | --- |
| N-01 登录标签 | N6识别、N5防错 | Accessibility、Typography |
| N-02 搜索缺失 | N6识别、N7效率 | Navigation、Components |
| N-03 重复导航 | N3控制、N4一致 | Navigation、Motion |
| N-04 历史跳转 | N3控制、N7效率 | Scrolling、Motion |
| N-05 抽屉焦点 | N3控制、N4一致 | Accessibility、Navigation |
| N-06 头像失败 | N1状态、N4一致 | Images、Feedback |
| N-07 形状与颜色 | N2语言、N6识别 | Accessibility、Touch targets |
| N-08 小字对比度 | N6识别、N8简约 | Color、Typography、Accessibility |
| N-09 表单校验 | N5防错、N9恢复 | Feedback、Text fields |
| N-10 回应读取/回滚 | N1状态、N9恢复 | Feedback、Controls |
| N-11 前台读取恢复 | N1状态、N9恢复 | Feedback、App lifecycle |
| N-12 选中状态 | N1状态、N6识别 | Accessibility、Selection |
| N-13 服务未启用 | N1状态、N5防错 | Feedback、Controls |
| N-14 Web导航间距 | N3控制、N4一致 | Navigation、Layout |
| N-15 形状排列 | N4一致、N8简约 | Layout |
| N-16 线程旧状态 | N1状态、N9恢复 | Feedback |
| N-17 审批终态 | N1状态、N5防错 | Feedback、Controls |
| N-18 迟到附件回调 | N3控制、N5防错 | Navigation、Sheets |
| N-19 自定义答案 | N3控制、N7效率 | Forms、Text fields |
| N-20 菜单遗漏 | N6识别、N7效率 | Menus、Navigation |
| N-21 Sheet取消 | N3控制、N4一致 | Sheets、Accessibility |

## 4. Nielsen 与 HIG 覆盖矩阵

### Nielsen 10 条

| 原则 | 本轮覆盖入口与处理 | 证据/边界 |
| --- | --- | --- |
| N1 系统状态可见 | 读取失败/缓存、创建/登录/保存 busy、模型检查/不可用、未发送/停止失败、加载 spinner | UX-07/10/13/16/18；通知保存、真实API停机/恢复实测；设备断网仍按独立场景补证 |
| N2 符合用户语言 | Bot/Thread/Task 保持词汇表；形状/颜色改中文；搜索明确 Bot/群名；状态不暴露内部枚举 | UX-09/14/15；N-07；不改业务实体或扩展搜索语义 |
| N3 用户控制与自由 | 读历史不被拉底；显式回到最新；抽屉关闭/返回/取消；手势取消不误引用 | UX-01/02/03/04/08/17；群滚动与 Drawer Web 实测，原生手势待验收 |
| N4 一致性与标准 | 复用原生导航、CardButton、ReadNotice、平台滚动适配；统一名称/状态属性和44pt目标 | UX-11/12/13/15；新增组件登记 `docs/design/components.md`，未删组件库 |
| N5 错误预防 | 无效创建不可按、提交 guard、模型写入互斥、旧 context 响应失效、未启用聊天不发送 | UX-10/18；N-09/10/13；真实提供商效果仍待 live |
| N6 识别优于记忆 | 可见消息操作入口、时间/引用替代操作、搜索范围、radio/checkbox 名称与状态 | UX-09/14/17；N-12 必须用真实 DOM/AX 复测 |
| N7 灵活高效 | 上拉历史与回到最新并存；保留手势快捷方式及可访问替代；键盘焦点闭环 | UX-04/08/14/17；不把 Web 键盘测试当 VoiceOver 测试 |
| N8 简约设计 | 状态仅在必要错误/忙碌时显示；保留缓存内容；Reduce Motion 去掉装饰位移；不按归档稿重画 | UX-05/06/07/15；遵守 R-40，不新增无用引导或说明段 |
| N9 错误识别与恢复 | 读取重试、保存回滚、草稿保留、明确空名、模型读取/写入重试、反应失败恢复 | UX-07/10/16/18；资料校验和真实API停机后的轮询恢复实测；实际provider任务失败与设备离线仍待验收 |
| N10 帮助与文档 | 必需的空态/错误说明帮助完成当下任务；设计权威、环境、OTA/原生发布说明更新 | UX-09/15/16；没有为满足原则额外新增帮助中心或产品文案噪声 |

### Apple HIG 相关维度

| 维度 | 本轮处理和范围 | 当前验证层级 |
| --- | --- | --- |
| Navigation / Components | 抽屉与导航时序、创建后栈操作；保留 NativeTabs、系统 Stack/Menu/Sheet | Drawer、Bot/群创建、Web菜单关闭/回焦点及sheet关闭通过；UIKit interactive pop、sheet、Liquid Glass未验收 |
| Motion / Reduce Motion | 动态偏好订阅、循环动画静态替代、取消复位和减少装饰位移；不无故移除功能性跟手位移 | 偏好单测/源码通过；真实 iOS 系统偏好、动画舒适性与性能未验收 |
| Gestures | 左右滑阈值、纵向失败/边缘保留、成功释放才引用、长按/滑动竞合及可见替代 | 源码已处理；原生边缘返回、惯性和触觉联动未验收 |
| Layout / Touch targets | 实体44pt操作目标、避免重叠hitSlop、Composer上方返回最新、可增高输入/按钮、登录可滚动 | 375群滚动/创建及44pt关闭、393形状3+3/60pt、430深色12px间距已实测；不同字体缩放下完整裁切清单仍待补 |
| Typography / Dynamic Type | 不关闭 RN Text 的字体缩放；相关固定高度改minHeight；保留语义层次 | 源码处理；浏览器尺寸与原生 Dynamic Type 是不同验收，后者未测 |
| Color / Dark / Increase Contrast | Web小字对比度、动态选中环、暗色token、键盘focus-visible；native配置automatic | Web 393深色CSS与颜色计算；iOS动态色/Increase Contrast及新binary实际配置未测 |
| Accessibility / VoiceOver | 标签、checked/busy/disabled、可见消息动作、Drawer模态AX与焦点、链接保持独立 | Drawer/通知、Bot形状/颜色、群成员、ModelMenu与插件/线程筛选Web AX已实测；真实VoiceOver未测 |
| Feedback | pressed、selected、disabled、busy、错误和重试保持一致；Spinner有状态语义 | 通知保存和表单错误真实Web记录；触觉反馈没有设备证据 |

### 主要入口覆盖说明

| 入口/任务 | 已覆盖的实现或运行检查 | 仍需补充的运行证据 |
| --- | --- | --- |
| 登录/冷启动/更新提示 | 登录AX、表单状态与既有真实隔离会话；StartupGate/OTA/native发布边界源码复核 | Google/GitHub真实OAuth本轮未作变更验收；新binary冷启动/强制更新待设备 |
| 首页/置顶/抽屉/搜索 | 首页读错误透传、抽屉状态与键盘、名称搜索入口；置顶语义保持 | 所有首页/搜索/置顶状态截图清单由owner追加 |
| Bot聊天/群聊/历史 | 共享滚动、真实145条群历史、追加不拉底、回到最新、消息替代动作 | Bot独立45秒追加轮询已实测通过；图片加载、所有长按/引用/附件交互回归仍按场景留证 |
| 线程/详情/Bot资料/建议/任务/插件 | 读取状态与重试、状态名称/语义和资料入口源码审查，root负责相应消费页修复 | Tasks首次失败/自动恢复、插件返回/分段选中及线程筛选四项/选中状态已实测；其余页面完整首用/正常/失败/返回截图由owner追加 |
| 设置/通知/工作区/记忆 | 资料空名恢复、通知名称/checked/保存禁用与最终服务状态；写入防重复与读状态 | 工作区切换及记忆失败的完整UI证据待owner追加；不得用单测冒充 |
| 审批/发送/停止/模型 | 现有审批回归、草稿与错误恢复、模型菜单来源/状态/写入guard | 独立三模型live、真实停止/网络失败、原生键盘/菜单待相应环境 |

## 5. 已记录的真实 Web 证据

### E-WEB-01：Drawer 的模态语义、焦点和导航

- 关闭时 AX 不暴露抽屉内部项；打开后隐藏底层页面的可访问内容。
- 打开后 Shift+Tab 从首项循环到末项；Escape 关闭并把焦点还给菜单按钮。
- 从抽屉进入设置并返回，没有残留抽屉状态。
- 首次打开曾出现 Web BackHandler 红条；限制原生平台注册后重测消失。
- 这些是 Web 行为记录，不证明 VoiceOver 或 UIKit 转场通过。截图/AX路径：待 owner 追加到 `issue-1296-evidence/`。

### E-WEB-02：真实群历史、失败回归和修复闭环

使用同一隔离会话和真实数据库/API，初始列表显示 046–145，API 分页为 100 + 45、145 条唯一记录。375 视口下滚动容器可视高度为 752。

| 阶段 | scrollTop / 内容高度 | 锚点/结果 |
| --- | --- | --- |
| 加载更早前 | 0 / 18942 | 消息046文字 y=167 |
| 第一版 helper 修复后的真实失败 | 26497 / 27249 | 直接到了新底部；046文字 y=-18023。此前逻辑单测成功没有证明实际浏览器接入正确 |
| Web ScrollView 适配后的回归 | 8307 / 27249 | 增加的内容高度为8307，scrollTop同步补偿；046文字仍 y=167，001已进入DOM |
| 用户点“回到最新消息” | 26497 / 27249 | 26497 = 27249 − 752 |
| 在历史位置追加146前 | 21817 / 27249 | 用户未处于底部 |
| 真实追加146后 | 21817 / 27497 | 内容增长248，scrollTop仍21817，没有强拉底 |
| 再显式回到最新 | 26745 / 27497 | 26745 = 27497 − 752 |

根因修复位于 `ChatScrollView.web.tsx`：标准 RN Web ScrollView 直接提供真实 scroll/content-size 事件。原生对应文件仍使用原键盘控制器；不能外推原生键盘行为已测。截图/DOM测量路径：待 owner 追加。

个人Bot独立追加也已真实验证：31条时上滚至scrollTop1598，内容高6290、可视高752；同一隔离会话追加第32条，正常45秒轮询后内容高6398、scrollTop仍1598，AX包含新消息。它覆盖正常轮询追加，没有把尚未实测的图片加载归为已通过。

### E-WEB-03：登录与新建/资料表单

- 初版登录页邮箱/密码在 AX 无名称；已补明确标签，修复后的最终 AX 文件待追加。
- 初版新建Bot空名仍可按创建；形状/颜色读出内部枚举；创建成功出现重复导航警告。393修复后实测猫/橙色DOM aria-checked=true、AX Value=1；形状实体60×60，空名创建disabled。有效名字创建时表单/取消/形状/颜色全禁用并显示创建中，成功进入Bot聊天，无新增POP_TO_TOP日志。最终393形状布局为3+3，坐标与已同步截图见E-WEB-10。
- 资料页空名显示“请输入名字”；恢复原名后旧错误清除，root 已实际操作确认。
- 截图/DOM路径：待 owner 追加；不保存邮箱、测试身份 ID 或 lease ID。

### E-WEB-04 / E-COLOR-01：深色与小字对比度

393 深色浏览器实际样式：页面 `#000000`，输入相关次要色为 `rgba(235,235,245,0.6)`。对比度按 sRGB 相对亮度计算，并将半透明前景先与实际背景合成；结果只适用于列出的 Web token/背景。

| 文字 / 背景 | 修复前 | 修复后 |
| --- | --- | --- |
| secondary / 白色page或surface | 3.44:1 | 5.16:1 |
| secondary / `#F2F2F7` grouped或bubble | 3.30:1 | 4.85:1 |
| danger / 白色page或surface | 3.55:1 | 5.38:1 |
| danger / `#F2F2F7` grouped或bubble | 3.18:1 | 4.83:1 |
| 深色secondary / 黑色、`#1C1C1E` | 6.36:1 / 5.95:1 | 保持 |
| 深色danger / 黑色、`#1C1C1E` | 6.16:1 / 4.99:1 | 保持 |

新返回最新按钮与模型菜单的14px文字改用 `colors.text`。iOS `PlatformColor` 系统动态色未按这些 Web 近似值强行替换。深色截图/计算留档路径待 owner 追加。

### E-WEB-05：通知开关保存状态

开关有名称且 AX checked 正常；保存时相关操作全部禁用并显示“正在关闭”；真实服务端最终状态为0。普通 Switch 的受控 value 已提供正确的 Web checked，不能把 radio 的 RN Web 映射问题外推成 Switch 也失败。截图/脱敏结果路径待 owner 追加。

### E-WEB-06：radio 真实语义回归

root 在模型菜单看到视觉已选勾号，但 DOM `aria-checked=null`、AX Value=0。它证明 `accessibilityState.checked` 的源码存在不足以确认 Web 可访问状态。flow 修复模型菜单，design 分区检查新建形状/颜色、群成员选择、ChoiceRow 及本轮 busy/disabled 控件；保留 native state，并为 Web 提供显式 ARIA。新建Bot的猫/橙色已通过真实DOM/AX检查，明确为aria-checked=true、AX Value=1；新群成员checkbox也已实测aria-checked=true、AX Value=1。插件分段tab原来AX均0，补显式aria-selected后应用/技能切换正确：选中项AX1、另一项AX0，各目标高44；不从这些控件外推全量通过。

模型菜单375真实回归已确认aria-checked=true、AX Value=1、expanded=true，Shift+Tab焦点闭环。截图已保存（29924 bytes），由owner归档到[模型菜单证据](issue-1296-evidence/model-menu-accessible-375.jpg)。聊天服务enabled=false时输入草稿后点击状态重试，草稿保留且发送disabled=true/aria-disabled=true；没有发送模型请求。

### E-WEB-07：头像产品/环境原因分离

相对头像 URI 需要按 API_URL 解析，Drawer 与设置共用 Avatar/后备状态，这是产品修复。隔离同源代理遗漏静态资源转发属于环境配置修复，单独记录；不能把代理错误全部归于 Mikka 产品，也不能只修代理而漏掉相对 URI 根因。最终截图/请求结果路径待 owner 追加。

### E-WEB-08：真实隔离API停机与自动恢复

root停止的是本次Docker中的Next API进程，没有改写或伪造响应，也没有影响生产。停机后chat/home/search明确显示“更新失败，仍显示上次内容”；模型选择请求失败显示“没换成 Mikka 默认：连不上 Mikka”及重试，原模型仍为Mikka；首次Tasks显示“任务加载失败”与重试，没有误呈空态。

恢复实际API并核验 `/api/version` 返回200和基线后，正常轮询自动恢复“还没有任务”，无需重开页面。**这是自动轮询恢复，不能写成点击重试成功。** 430宽深色任务失败/恢复两张截图已由root保存，具体路径待补。该场景覆盖真实服务不可达，不代替设备网络断开或原生OfflineBanner测试。

### E-WEB-09：群聊最终锚点与消息sheet

最后一轮群聊375复测使用已继续增长的fixture：加载更早前047文字y142、scrollTop0、内容高19191、可视高752；加载后047仍y142，scrollTop8530、内容高27721、可视高752，001在DOM只出现1次。它与E-WEB-02较早轮次的046数字分别记录，不能混成同一快照。

可见消息操作→回复返回群聊，引用显示正常，取消引用正常。/message的标题和关闭入口实际出现，DOM关闭目标44×44，关闭返回群聊，再返回时保留搜索查询。最终冻结源码再次回归：最新100条为048–147，加载更早前048文字y167、scrollTop0/content19040/viewport752；载入001–047后048仍y167、scrollTop8681/content27721/viewport752，001仅有1条。点击“回到最新消息”后scrollTop26969 = 27721 − 752。[最终截图](issue-1296-evidence/group-history-anchor-375.jpg)已归档。

/attach也已实测关闭入口为44×44，关闭返回成功，群聊输入草稿保持。两个Web sheet的运行检查不等于原生系统picker、UIKit sheet或迟到picker真实设备测试。

### E-WEB-10：最终创建菜单、导航、布局和选择状态

- 375主页“新建”列出Bot和群聊两项，Escape关闭后焦点回到新建按钮。新群空表单、仅填名未选成员时创建均disabled；选中成员后checkbox aria-checked=true、AX Value=1，创建成功进入新群，返回首页可见该群。没有新增POP_TO_TOP日志，日志中仅保留01:07的旧记录。
- 393新建Bot形状为3+3，三列x=94.5/166.5/238.5，两行y=270/342，每个60×60；猫/橙色aria-checked=true。[最终表单截图](issue-1296-evidence/new-bot-form-393.jpg)已归档，29802 bytes。
- 430深色搜索最终tablist bottom=64、searchbox top=76，相距12px，无重叠。[最终搜索截图](issue-1296-evidence/search-dark-430.jpg)已归档，28851 bytes。
- 插件页返回按钮已实际出现；应用tab aria-selected=true、AX Value=1，目标高44。切换技能后技能AX1、应用AX0，并显示正常加载状态。随后真实技能目录读取失败，页面显示“技能加载失败”及重试，仍能正常返回首页；没有将失败显示成空结果。
- 线程筛选菜单完整显示全部、等待你、进行中、已解决四项；选择进行中后badge和再次打开的menu radio AX1正确，恢复全部正常。菜单状态测试没有发出真实模型、邮件或日历请求。

## 6. 已运行的源码、单测和构建检查

| 检查 | 已记录结果 | 原始证据路径与范围 |
| --- | --- | --- |
| `pnpm --filter @mikka/mobile typecheck` | 最终源码冻结后02:14:17 UTC完整检查退出0 | Docker `/tmp/mikka-1296-typecheck.out`、对应 `.exit`及最后工具回执；所有当前源文件均通过typecheck，最终CI仍需绑定合并前head |
| `pnpm test:mobile` | 最终源码冻结后02:14:20 UTC完整检查退出0，25+15+105=145项通过、0失败、0跳过，包含NavBar/Segmented最后修复 | Docker `/tmp/mikka-1296-mobile-tests.out`、对应 `.exit`；先前132项结果已由145项完整结果替代，不能把下列子集重复加总 |
| `pnpm lint` | 最终源码冻结后02:14:31 UTC检查退出0；oxlint无错误、55项migration测试通过、UI检查无错误 | Docker `/tmp/mikka-1296-lint.out`、对应 `.exit` |
| `pnpm --filter @mikka/mobile exec expo export --platform web` | 最终源码冻结后02:14:35 UTC Expo Web导出退出0 | Docker `/tmp/mikka-1296-export.out`、对应 `.exit` |
| `git diff --check` | 各分区及文档检查无空白错误 | 当次工作树检查；最终提交前由owner统一执行 |
| 读取/滚动/分页/模型回归子集 | 6文件共20/20：api-read-state 2、chat-scroll 3、group-history 3、model-menu-write 3、既有model-menu-read 4、model-menu-view 5 | `apps/mobile/tests/*.test.mts`；已纳入test:mobile，不再另把这20项加到整套结果里重复计数 |
| Reduce Motion偏好 | 2个行为测试通过：原生监听/竞态和Web偏好/清理 | `apps/mobile/tests/motion-preference.test.mts`；mock/逻辑测试，不是真机动画验收 |
| 最后追加组件回归 | PendingActions 5/5、OpenUI问答3/3、attach-sheet 5/5，合计13/13通过；已加入test:mobile | API/系统宿主均mock；不能写成真邮件、日历、系统picker或native通过。已纳入02:14整套145项，不再次重复加总 |
| 原生发布验证脚本 | 只执行JSON样例解析：退出0、build ID精确、真实换行、runtime/fingerprint映射正确 | `.github/workflows/mobile-native.yml` 中验证JS；没有调用付费build/submit，不是原生构建成功证据 |

这些结果是本轮 Docker 回归；不能代替最终 PR head 关联的必需 GitHub CI。上游 main 整合、源代码或环境变化后，owner 按现有规则补跑受影响检查并更新本节。[检查记录](issue-1296-evidence/verification.json)保存各退出码、完成时间、日志哈希和源码哈希。原始完整运行日志不随公开仓库提交。现有必需CI的Core unit checks新增`pnpm test:mobile`，防止本轮回归测试只在沙盒运行；没有新增或恢复浏览器E2E gate。

## 7. 原生与真实模型调用的明确边界

### 原生

- 当前没有原生设备/模拟器。因此 NativeTabs、UIKit Stack interactive pop/sheet、Liquid Glass、触觉反馈、VoiceOver、Dynamic Type、系统 Reduce Motion/Increase Contrast 和 native keyboard 均没有本轮设备验收。
- `app.json` 的 automatic 是配置修复，需要兼容新 fingerprint 的二进制。保留既有 iOS 动态色和原生键盘控制器，没有用 Web 组件替换它们。
- 新 `.github/workflows/mobile-native.yml` 将在 main 配置变更或 main手动dispatch后，等待精确提交的既有CI、以现有凭证构建、核验完成的iOS build及gitCommitHash，再提交同一build id。**本次workflow运行、签名、构建与TestFlight结果待本PR合并后追加。**
- OTA发布、App Store Connect上传、TestFlight处理/可用性、实际安装、设备验收和App Store公开发布是不同结果；不合并成一个“已上线”结论。

### 三条真实模型路径

E-MODEL-01：对当前隔离应用账户的真实读取探测返回200，但没有已配置 API keys、subscriptions、devices 或 daemon。聊天服务enabled=false另指此部署的回复运行条件，不是模型可用性的同义词。它证明当前测试身份的配置为空，不代表组织不存在授权凭证，也不证明生产模型可用或不可用。不得输出任何身份 ID、lease ID、邮箱或凭证值。

| 路径 | 规定模型 | 本轮live状态 |
| --- | --- | --- |
| API key | `deepseek-flash` | 未执行真实模型任务；当前隔离身份尚无可执行配置链。不得改用别的API模型，发起付费探测前仍须通过既有model guard |
| 官方Claude Code订阅 | `claude-haiku-5-5` | 未执行；当前测试身份没有对应订阅/执行设备链 |
| 官方Codex订阅 | `gpt-6-luna` | 未执行；当前测试身份没有对应订阅/执行设备链 |

菜单能打开、状态能显示、模型读写helper通过或HTTP200都不能替代上述独立live验收；不能由一条推断其它两条。不得为容量或通过测试改用Pro/其它模型。本轮没有宣称任何真实模型调用、自动回退计费或后续任务路由已通过。具体探测路由、脱敏输出文件和后续独立结果由owner追加。

## 8. 合并、发布及生产验收记录

本文件随实现PR保存合并前证据；最终动态结果追加到 [Issue #1296 正文](https://github.com/alexj11324/Mikka/issues/1296)，包括对应链接、精确SHA及尚未完成的项目。下表保留编写时状态，不把未来动作预填为成功。

| 项目 | 结果 |
| --- | --- |
| 最终PR / head / review | 待本PR合并后追加；不预填PR号 |
| 必需CI及其精确提交 | 待本PR合并后追加 |
| Squash merge SHA / 时间 | 待本PR合并后追加 |
| Vercel生产deployment、READY及域名提交校验 | 待本PR合并后追加 |
| 生产OTA channel / update group / runtime | 待本PR合并后追加 |
| 新EAS iOS build / 版本 / fingerprint | 待本PR合并后追加 |
| App Store Connect提交 / TestFlight处理 | 待本PR合并后追加 |
| 安装版本与原生设备验收 | 待兼容build及设备可用后追加；当前未验收 |
| 真实生产账户/任务验收（脱敏） | 待本PR合并后追加 |
| Sandbox与服务停止时间 | 待本轮工作结束后追加 |

生产发现问题时遵循既有闭环：回 Docker 隔离复现、修复和回归，再经PR/CI/merge重新部署并验收。本报告的待补项不是虚构通过，也不新增人工逐项审批。Issue是否达到关闭条件由owner依据#1296 DoD与最终证据判断。
