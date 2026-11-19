# 全产品功能断层审计报告

日期：2026-11-19
基线：public `3e4658127`（分支 `fix/qualification-on-ubuntu-24`），hosted `.hosted-ui` `4fdebe675`

方法：[mikka-action-coverage](../../.claude/skills/mikka-action-coverage/SKILL.md) 能力↔入口双向追踪。
10 个领域并行追踪产出 59 条候选，每条经两个独立视角验证（refute + impact），共 128 个代理、0 错误。

## 结论

**59 条候选 → 45 条确认、12 条有意为之、2 条被反驳。**

| 严重度 | 数量 | 含义 |
| --- | --- | --- |
| 4 | 1 | 静默失效，核心承诺被破坏 |
| 3 | 8 | 已声明的能力用户完全到不了 |
| 2 | 26 | 能到达但误导、藏得深或行为不一致 |
| 1 | 10 | 一致性/恢复体验问题 |

按分类：`missing-affordance` 18、`action-parity-gap` 11、`misleading-feedback` 5、`error-recovery` 4、`permission-mismatch` 3、`state-model-drift` 2、`dead-control` 1。

**这不是「系统坏了」，是大量功能停在半接通状态。** 没有崩溃、没有报错、测试全绿，但用户走不到。

### 验证状态

`docs/review-checklist.md:48` 要求每条审计标明验证状态。本报告的标注规则：

| 状态 | 本报告中的含义 |
| --- | --- |
| `source-only` | 全部 45 条确认项。均由上述 public / hosted 源码对双向追踪（能力 ↔ 入口）得出，经 refute + impact 双视角复核，**未**在真实运行的产品上复现。 |
| `runtime-verified` | 本报告 0 条。基线 `3e4658127` 上没有做浏览器或真机验收。 |
| `not-tested` | 运行态行为、权限拒绝路径、移动端布局均未验证；基于这些的判断不构成结论。 |
| `intentionally-unavailable` | `## 有意为之（12 条，不修）` 一节。 |

需要运行时证据的条目，按 [mikka-browser-qa](../../.claude/skills/mikka-browser-qa/SKILL.md) 补齐后再改标 `runtime-verified`。

### 四类断链模式

1. **读有写无**：`getWorkspaceBotDefaults` 被读，`updateWorkspaceBotDefaults` 零调用者；`personalInstructions` 会被注入 prompt，但没有输入框。
2. **写有读无**：每条学到的记忆以 `pending` 入库，但 UI 从不渲染 `pending`。
3. **数据有、编辑无**：Task 的 `delegate` 行只渲染 `value`，没有 menu/onClick，且无 delegate 时整行不渲染。
4. **组件有、挂载无**：能力在服务端完整，客户端连 registry 都没注册（`captures.shareCapture`）。

## 严重度 4：唯一一条静默失效

记忆页的 `pending` 事实。`lib/profile/store.ts:94` 把每条新事实写成 `reviewStatus: 'pending'`，`lib/profile/memory.ts:153-155` 把它们单独放进 `pending` 数组返回，但两层 UI（`components/slots/settings-memory.tsx`、`.hosted-ui/slots/settings-memory.tsx`）都只消费 `facts`，`reviewFact` 全仓库零调用者。

**验证阶段纠正了一个关键判断**：`lib/profile/store.ts:155-159` 的 `profilePromptSection` 只过滤 `state='active'`，**不过滤 `reviewStatus`**，所以这些待确认记忆**已经进入 Coordinator 的 prompt**。真实症状比「记忆不生效」更糟：**用户看不到、也无法批准，但 Mikka 已经在用它们。**

已在本次修复（见下）。

## 严重度 3

### [3] 设置 › 模型与订阅 — Agent 配置 › Skills（repository 来源）

- 用户任务：编辑并保存一个声明了 repository skill 的 Agent 配置
- 命令：`profileRequest (PATCH/POST /api/factory/agent-profiles)`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：components/settings/factory-profiles-settings.tsx:166-184（Repository skills 区，含 repositorySkillName/addRepositorySkill 文案）与 docs/design/decisions/2026-11-10-1700-agent-profile-skill-sources.md（repository 是四种 Skill 来源之一）
- 实际路径：.hosted-ui/slots/settings-models.tsx:36 → .hosted-ui/lib/models/profiles.tsx:20 ProfilesSection → :69 ProfileForm；:102 的保存按钮在 draft.skills 含 catalog 外 id 时 disabled，编辑器里没有任何 repository 输入
- 建议修复：在 hosted ProfileForm 补回 repository skill 输入（复用公开层的 REPOSITORY_SKILL 校验），并让保存条件像公开层一样排除 `repository:` id 的 missing 判定。

### [3] 设置 › 模型与订阅 — Agent 配置 › 个人 Skill 分享

- 用户任务：把自己安装的 Skill 分享给团队工作区，供同事的 Agent 配置使用
- 命令：`shareWorkspaceSkill`
- 分类：`missing-affordance` · 层：`hosted`
- 承诺入口：components/settings/factory-profiles-settings.tsx:154-156（分享/取消分享按钮）与 messages/en.json:3540-3541（shareSkill/unshareSkill）；决策 2026-11-10-1700 把「owner's explicit team-workspace share」列为 Skill 来源
- 实际路径：.hosted-ui/slots/settings-models.tsx:36 → .hosted-ui/lib/models/profiles.tsx:69-107 ProfileForm 只渲染 skill 开关，没有分享控件；shareWorkspaceSkill 的唯一调用者在公开层
- 建议修复：在 hosted ProfileForm 的 personal skill 行加「分享/取消分享」按钮，调用 shareWorkspaceSkill 后重读 catalog。

### [3] 设置 › 账号、安全、计费 — 活动时间线 (activity timeline: credential uses, external actions, coordinator reminders)

- 用户任务：查看 Bot 用我的已保存登录做过什么、哪些外部操作被批准/拒绝、Coordinator 提醒了什么
- 命令：`listActivity`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：设置 › 活动 时间线 (docs/settings-backend/activity.md:10 与 :78 把它列为设置页功能, 与已保存登录同批建成)
- 实际路径：无任何渲染路径: 全仓库只有 app/actions/settings-activity.ts:58 与 docs 命中 listActivity; app/api/settings/[read]/route.ts 的 READS(31-59) 没有 activity; lib/desktop-rpc/registry.ts 的 settings-activity 白名单(260-264)只暴露 5 个 saved-login action, 漏掉 listActivity; app/api/mobile 下无 activity 路由; messages 里也没有 Settings.sections.activity
- 建议修复：Add an 活动 section (or fold the timeline into 密钥与登录/数据与隐私) driven by listActivity with cursor pagination and the three filters; if it is deliberately not shipping, remove the action and the doc so it stops reading as a shipped capability.

### [3] 设置 › 偏好设置 — user_time_zones（时区 / 自动-手动）

- 用户任务：把每日简报和提醒的时区改成本地正确的时区（自动检测错了时手动指定）
- 命令：`setTimeZone`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:14 — user_time_zones.source 为 'manual' 时表示「picked in Settings」; docs/settings-backend/prefs.md:51-72 完整描述 getTimeZoneSetting/setTimeZone
- 实际路径：无。偏好设置两层只渲染外观/语言/任务编号前缀/线程标题/重新播放引导（.hosted-ui/slots/settings-preferences.tsx:26-28；components/slots/settings-preferences.tsx 的 AppearanceSection + IssuePrefixSettings + ReplayOnboarding），没有任何时区行
- 建议修复：在偏好设置加一行「时区」：显示 getTimeZoneSetting 的当前值/检测值，提供「自动」与 IANA 时区选择，保存调用 setTimeZone 并展示 timeZoneInvalid 错误

### [3] 设置 › 记忆与建议 — user_preferences.suggestionSources（数据来源）

- 用户任务：不让某个已连接的 App（Gmail / Notion / Slack / 日历）的内容进入建议、每日简报和记忆抽取
- 命令：`setSuggestionSource`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:80-97 — 列出每个 Composio app 的 connected/enabled，并说明「GitHub and Linear are not Composio apps and have no switch here」，即四个 Composio app 应有开关
- 实际路径：无。记忆页只有「使用记忆」开关和事实列表（components/slots/settings-memory.tsx:30-34、.hosted-ui/slots/settings-memory.tsx:27-57）；连接页的开关走 connected-apps 的账号启用/停用，是另一个命令，且会连带停用该 App 的其它能力
- 建议修复：在记忆与建议加「数据来源」分组：对 gmail/googlecalendar/notion/slack 各一行，显示已连接状态，开关调用 setSuggestionSource，未连接时禁用并提示先去连接

### [3] 设置 › 偏好设置 — user_preferences.personalInstructions（个人指令）

- 用户任务：给 Coordinator 和自己所有 Bot 写一段长期生效的个人指令
- 命令：`updatePreferences`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:180 — 注入 prompt 的段落写着「The person wrote these in Settings」; docs/settings-backend/prefs.md:42 说明 updatePreferences 接受 personalInstructions（≤2000 字）
- 实际路径：无。偏好设置两层都没有指令输入框（.hosted-ui/slots/settings-preferences.tsx:26-28 只挂 IssuePrefixSection/ThreadTitleSection/ReplaySection；公共层只有外观、语言、任务编号前缀、重新播放引导）。通知页只发推送字段
- 建议修复：在偏好设置加「个人指令」多行输入（2000 字上限），失焦保存调用 updatePreferences，展示 personalInstructionsTooLong 错误并支持清除

### [3] 任务 — Task Agent delegate

- 用户任务：把任务交给（或改交给/取消交给）某个 Agent、Bot 或 Profile
- 命令：`updateIssueMetadata({delegate})`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：任务页 “Handed to / 委派给” 行（components/workspace/task-detail-frame.tsx:260）；R-60 要求把任务交给 bot 后在负责人下方单独一行显示（docs/design/rules.md:214-216）；.hosted-ui/evidence/2212-action-coverage/task-project.json:746-754 的 CD17 声称有 “Agent delegate picker”
- 实际路径：该行只有 value，没有 menu/onClick，hosted 渲染为静态 span（.hosted-ui/slots/task-detail.tsx:628-632）；负责人选择器只列 active members（components/workspace/issue-assignee-menu.tsx:37-40；app/actions/issue-metadata.ts:26 注释 “R-60 keeps the UI human-only”）；全仓没有任何组件调用 persist({delegate})。delegate 只在派发时由 lib/dispatch-delegate.ts:49 自动写入一次。
- 建议修复：在任务页增加 delegate 选择器（Bot/Profile/Agent，数据可由 getIssuePropertyOptions 扩展），或在现有 “Handed to” 行上挂菜单，调用 updateIssueMetadata({delegate}) 并支持 null 清除；否则删除该只读行与 CD17 的 picker 声明。

### [3] 文件、制品与评审 — 运行截图/录屏的公开分享链接 (run_capture_shares)

- 用户任务：查看并撤销一张已随 PR 公开的截图/录屏分享链接（PR 发布时服务端自动建链，用户无法拒绝也无法收回）
- 命令：`shareCapture / stopSharingCapture`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：app/actions/captures.ts:19-30 的两个导出都写成用户可用能力（「A new share link for the capture, opened at /api/captures/shared/<token>」「Ends every share link to the capture」），文件头注释称「Share links for a thread's screenshots and recordings, as for artifacts: the token comes back once, only its hash is kept, revoking ends it」；docs/mcp.md:127-129 也写明 run_capture_shares 是「hashed mkc_… tokens, revocable, as artifact shares」
- 实际路径：无任何 UI/路由/移动端路径。全仓库 grep app/actions/captures 只有 apps/frontend/scripts/application-plugin.test.mjs:54 一处，且该处是断言 shareCapture 被拒绝（FRONTEND_ACTION_NOT_ALLOWED: captures.shareCapture）。lib/desktop-rpc/registry.ts 没有 captures.* 条目（其余 13 个本域 action 都在），而 apps/frontend/scripts/application-plugin.mjs:72,162 用 registry 作为客户端可用 action 的白名单，所以 web/desktop 客户端在构建期就调不到这两个 action；app/api 下只有读取路由 GET app/api/captures/shared/[token]/route.ts，没有创建或撤销的 POST/PATCH；components、components/workspace/factory-evidence.tsx 的 EvidenceViewer、thread-artifacts 的截图网格、.hosted-ui、hooks、apps/mobile 均无 share/stop 调用，messages/*.json 也没有任何截图分享文案
- 建议修复：把撤销入口补到截图真正被看到的地方，而不是新增页面：在 components/workspace/factory-evidence.tsx 的 EvidenceViewer 操作区（与现有 download 按钮同一行）加「复制分享链接 / 停止分享」，对 thread-artifacts 的截图/录屏项同样处理；同时把 captures.shareCapture / captures.stopSharingCapture 注册进 lib/desktop-rpc/registry.ts 与 lib/desktop-rpc/schemas.ts（oneId），否则客户端仍无法调用。若产品上只允许发布流程建链，则最小修复是只暴露 stopSharingCapture（不需要新建链接的能力），并在「已共享的链接」里按 issue/run 聚合展示 run_capture_shares，让用户至少能收回公开链接；此时应删除 shareCapture 或补注释说明其为服务端内部能力，避免继续以用户能力的形式存在于 app/actions/captures.ts。


## 严重度 2（26 条）

### [2] 设置 › 模型与订阅 — API Key 列表的读取/保存错误

- 用户任务：在 API Key 读取或保存失败时看到原因并重试
- 命令：`getApiKeys`
- 分类：`error-recovery` · 层：`hosted`
- 承诺入口：公开层对同一读取显示 SettingsSaveError + 重试（components/settings/api-key-settings.tsx:80），对 refetch/share/delete/features 的失败显示可重试错误（:87）
- 实际路径：.hosted-ui/lib/models/binding.tsx:177 的 noKeys 文案 → .hosted-ui/components/settings-models.tsx:537 的空状态；binding.tsx:202 只渲染 enabled 的错误，keys.failed / keys.loadError 从未渲染
- 建议修复：在 API keys 卡片渲染 keys.loadError / keys.failed 的 Failed 行（带重试），读取失败时不要显示「No API keys yet」。

### [2] 设置 › 模型与订阅 — 模型顺序读取失败时的整页状态

- 用户任务：在模型顺序读取失败后仍能打开订阅/API Key/Agent 配置并重试
- 命令：`getModelOrder`
- 分类：`error-recovery` · 层：`hosted`
- 承诺入口：公开层模型顺序失败只影响该区块，其他区块照常渲染且带重试（components/settings/model-order-settings.tsx:50）
- 实际路径：.hosted-ui/slots/settings-models.tsx:39 `if (!bound) return <Empty>{order.loadError ?? t('loading')}</Empty>`；bound 来自 .hosted-ui/lib/models/binding.tsx:48（!order.data 即 null）
- 建议修复：bound 为 null 时仍渲染页面壳与 after 里的订阅/API Key/Agent 配置，并把 order.loadError 用带重试的 Failed 显示。

### [2] 设置 › 模型与订阅 — 模型分组 › 订阅凭据标题

- 用户任务：分辨模型列表里每组模型属于哪个订阅账号
- 命令：`getModelOrder`
- 分类：`misleading-feedback` · 层：`hosted`
- 承诺入口：.hosted-ui/lib/models/binding.tsx:73「The template's providers: one per credential」——模板的 provider 卡头显示凭据名
- 实际路径：.hosted-ui/lib/models/binding.tsx:76-87 providers → .hosted-ui/components/settings-models.tsx:417 <b title={p.name}>{p.name}</b>
- 建议修复：订阅组标题改用 provider 文案或 subs.state 里的 connection.account；`head.name` 只作为模型显示名使用。

### [2] 设置 › 模型与订阅 — 订阅模型 › 自动启用新模型

- 用户任务：关闭或开启「订阅刷新后自动启用新模型」
- 命令：`setAutoEnable`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/acceptance/self-hosted-batch/enabled-models-api.md:13 与 :46（auto enablement 的行为约定）
- 实际路径：无 UI：.hosted-ui/lib/models/enabled.ts:6 只导入 getEnabledModels/setModelEnabled；公开层完全不用 enabled-models；唯一注册处 lib/desktop-rpc/registry.ts:227（同一 Web UI 的传输白名单，不是独立客户端界面）
- 建议修复：在订阅的模型组加「自动启用新模型」开关（读 EnabledModelsSource.autoEnable，写 setAutoEnable）。

### [2] 设置 › 模型与订阅 — Agent 配置 › 从模板新建

- 用户任务：从模板新建 Agent 配置
- 命令：`profileRequest (POST /api/factory/agent-profiles)`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：公开层 Add 菜单：Blank + Investigator/Planner/Implementer/Reviewer 四个模板（lib/factory/agent-profile-templates.ts:10-64；messages Settings.agentProfiles.templates.*）
- 实际路径：.hosted-ui/lib/models/profiles.tsx:26 的 Add 按钮直接 `setEditor({})`（只开空白编辑器），没有模板菜单
- 建议修复：hosted Add 按钮改成菜单：空白 + AGENT_PROFILE_TEMPLATES（setEditor({template:id})）。

### [2] 设置 › 模型与订阅 — 云端模型（Hosted models）入口

- 用户任务：在模型设置里管理或充值云端模型
- 命令：`CloudModelSettings (/api/cloud/status + /api/cloud/models/billing)`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：契约 SettingsModelsProps.cloudUserKey（components/slots/settings-models-contract.ts:4）与公开层 `{cloudUserKey && <CloudModelSettings .../>}`
- 实际路径：.hosted-ui/slots/settings-models.tsx:23 `export function ApiAndSubscriptions({ workspaceId }: SettingsModelsProps)` 丢弃 cloudUserKey，页面不渲染 CloudModelSettings
- 建议修复：hosted slot 接收 cloudUserKey，并在 API keys 卡片后渲染 CloudModelSettings（或提供等价入口）。

### [2] 设置 › 账号、安全、计费 — 计费 › 订阅按钮 (resource plan checkout availability)

- 用户任务：管理员订阅 Mikka Pro
- 命令：`startPlanCheckout (hosted 实际走 /api/workspaces/:id/billing 的 checkout)`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：计费页在资源价未配置时把订阅按钮置灰并说明 billingResourcePlanUnavailable (public 层 billing-view.tsx:50 与 :54)
- 实际路径：.hosted-ui/slots/settings-billing.tsx:93-95 只判断 data.live || data.hasCustomer 与 busy, 完全不读 data.resourceCheckoutAvailable, 也没有 public 的 billingResourcePlanUnavailable 说明行; 点击后 lib/billing/service.ts:120-127 抛错, 只在 :106 显示一条 actionError
- 建议修复：Mirror the public guard in .hosted-ui/slots/settings-billing.tsx: `disabled={busy || !data.resourceCheckoutAvailable}` and render the billingResourcePlanUnavailable note when `!data.live && !data.resourceCheckoutAvailable`.

### [2] 设置 › 工作区、团队、成员、权限、治理 — Workspace member（工作区成员）

- 用户任务：把某人从工作区彻底移除（删除成员行、清掉其团队资格、撤销同一邮箱的待处理邀请），而不只是停用
- 命令：`removeWorkspaceMember`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/workspace.md:64 以「移除成员」为一级契约（权限、不可移除自己/最后一位管理员、副作用、错误码都写明）；成员页脚 copy（messages/zh-CN.json Members.footer.admin「管理员可邀请、调整角色和停用成员」）显示产品目前只提供停用
- 实际路径：没有任何 UI 调用方。全仓 rg 只命中 app/actions/workspace-settings.ts 自身与 docs；lib/desktop-rpc/registry.ts 未注册该 action（只注册了 collaboration.removeMember，那是任务级成员），app/api/mobile/settings 也没有写路径（移动端成员页是 /settings/members 的 WebView，见 lib/mobile-web-target.ts:8）。其唯一审计事件 member.removed 只在 lib/workspace-admin/members.ts:184 发出，因此该事件在实际产品中永远不会产生。
- 建议修复：在成员行 ⋯ 与批量条加「移除成员」，确认框写明会移除成员资格、其团队资格和同邮箱待处理邀请（可选「Bot 转交给…」），走已有 removeWorkspaceMember；若产品决定停用就是终态，则删掉该 action、其文档条目和 member.removed 审计动作，避免留下永不触发的写路径。

### [2] 设置 › 工作区、团队、成员、权限、治理 — Team lifecycle（团队归档/恢复/移除分组/硬删除）

- 用户任务：事后查「谁在什么时候归档、恢复或移除了这个团队」
- 命令：`getTeamLifecycleAudit`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/design/decisions/2026-11-07-2340-team-lifecycle-retention.md「审计、恢复与发布」：生命周期事件与工作区变更同事务写入 team_lifecycle_events，「日志不以 Team 外键级联，因此移除 Team 后管理员仍可查询」；.hosted-ui/evidence/2212-action-coverage/focused.json 的 TEAM-AUDIT 条目已标注 remaining = 「User-facing audit discovery … remain open」，owner Mikka#2212
- 实际路径：只注册在 lib/desktop-rpc/registry.ts:282，无任何组件/hook 调用（rg -n getTeamLifecycleAudit 在 components/.hosted-ui/hooks 无命中）。审计日志页（.hosted-ui/slots/settings-audit.tsx）只读 workspace_audit_events，lib/audit/events.ts 的动作目录里没有任何 team.* 生命周期动作（只有 team.access_changed，见下一条），所以管理员在 UI 里查不到归档/恢复/移除分组/硬删除的历史。
- 建议修复：在审计日志页加一个「团队」来源（或在团队页加「历史」入口）读取 getTeamLifecycleAudit；或者把 recordLifecycle 同时写入 workspace_audit_events 的 team.* 动作，让现有 listAuditLog/导出覆盖，避免第二套查询入口。

### [2] 设置 › 工作区、团队、成员、权限、治理 — Workspace member（停用确认文案）

- 用户任务：点「停用成员」前判断这个操作到底会拿走什么
- 命令：`updateWorkspaceMember`
- 分类：`misleading-feedback` · 层：`both`
- 承诺入口：messages/en.json / messages/zh-CN.json 的 Members.confirmSuspend：「将「{name}」停用。该成员将无法访问工作区成员目录；已有任务协作权限不变。」（英文同键："They will lose access to the workspace member directory; access to existing task collaboration stays the same."）；Members.footer.admin 又称「成员资格不改变已有任务的单独授权」
- 实际路径：官方层 .hosted-ui/slots/settings-members.tsx:159-161 describe() 在停用确认框里渲染这句 Members.confirmSuspend（:229 Confirm points），用户看到的就是它
- 建议修复：改写为「该成员将立即失去此工作区的全部访问（含现有任务协作），其分享与 Bot 会一并暂停；恢复后 Bot 与任务授权回来」，与 §8.3 / releaseDepartingMember 的真实副作用一致；footer 那句也一并改成「成员资格不自动授予任务权限」，避免被读成「停用不影响任务」。

### [2] 设置 › 工作区、团队、成员、权限、治理 — Team membership audit（团队权限变更审计）

- 用户任务：在审计日志里核对「谁把某人加进/移出团队、谁改了团队负责人」
- 命令：`changeTeamMember`
- 分类：`action-parity-gap` · 层：`both`
- 承诺入口：AUDIT_ACTIONS 把 'team.access_changed' 归入 permission 类别并定义了 {team, from, to} 元数据；审计日志页的类别过滤含「权限」（lib/audit/categories.ts，.hosted-ui/slots/settings-audit.tsx 的 categoryFilter）
- 实际路径：changeTeamMemberBody（:117-151）在 join/leave/add/remove/owner/member 六个分支里只写 teamMembers 与 workspaceListChanged，从不调用 enqueueWorkspaceAudit；rg -n "team.access_changed" 除 lib/audit/events.ts 与其单测外无任何生产写入点
- 建议修复：在 changeTeamMemberBody 的 add/remove/owner/member/join/leave 分支写入 enqueueWorkspaceAudit({ action: 'team.access_changed', target: { type:'team', id, label: team.name }, metadata: { team: team.name, from, to } })，与该动作已定义的 schema 对齐；再在审计页确认它落在「权限」类别。

### [2] 设置 › 记忆与建议 — user_preferences.dailySuggestions（每日建议）

- 用户任务：关掉每天早上的建议/每日简报（但继续保留记忆）
- 命令：`updatePreferences`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:47 — 「Turning 记忆 back on leaves 每日建议 off, so the person turns it on again (the UI shows the S-G state 「需要先打开记忆」 while 记忆 is off)」
- 实际路径：无。通知页只渲染 NOTIFICATION_SWITCHES + pushWhen（hooks/settings/use-notification-settings.ts:14，components/slots/settings-notifications.tsx 与 .hosted-ui/slots/settings-notifications.tsx 同）；记忆页只有 memoryEnabled（components/slots/settings-memory.tsx:30-34）
- 建议修复：在记忆与建议（或通知）加「每日建议」开关，记忆关闭时禁用并显示「需要先打开记忆」；保存走 updatePreferences({ dailySuggestions })

### [2] 设置 › 记忆与建议 — user_facts scope（global / workspaces / projects）

- 用户任务：把一条记忆限制在某个工作区或项目内，而不是全局生效
- 命令：`setFactScope`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:104-106 — getMemory 每条返回 scope 与 allowed actions；lib/profile/memory.ts:136 为每条 fact 列出 'setScope'
- 实际路径：/settings?section=memory → components/slots/settings-memory.tsx:47 只显示 fact.repository（「仅在 {repository}」），hosted MemoryPanel 也没有 scope 控件；scopeOptions 从未被消费
- 建议修复：在 fact 行或编辑面板加范围选择（全局 / 指定工作区 / 指定项目），选项来自 scopeOptions，保存调用 setFactScope

### [2] 设置 › 记忆与建议 — 全部记忆（clearFacts）

- 用户任务：一次清空 Mikka 记住的所有内容
- 命令：`clearMemory`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:164-172 — clearMemory 删除该人所有未删除的 user_facts，返回被清除的数量（「which is the count 记忆 showed」）
- 实际路径：记忆页只提供逐条删除（components/slots/settings-memory.tsx:51 的 Trash 按钮 → hooks/settings/use-memory-settings.ts:61 removeFact）；hosted 同样只有 onForget 单条删除（.hosted-ui/slots/settings-memory.tsx:54）
- 建议修复：在记忆页加「删除全部记忆」危险行，二次确认后调用 clearMemory，并用返回的 removed 数量给出结果提示

### [2] 设置 › 记忆与建议 — 删除记忆后的撤销（undoRemoveFact）

- 用户任务：误删一条记忆后两分钟内恢复
- 命令：`undoRemoveFact`
- 分类：`verified-intentional` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:162 — 「Deletion offers a two-minute owner-only undo window」; lib/profile/memory.ts:134 为已删除事实返回 'undo' 动作
- 实际路径：删除是即时软删除（components/slots/settings-memory.tsx:51 → hooks/settings/use-memory-settings.ts:61 removeFact），页面没有撤销；hosted MemoryPanel 在 mikka 模式下不渲染 Undo（.hosted-ui/components/ui/memory-panel.tsx:923 `{forgot && !mikka ? ...}`），只显示「已删除「text」」
- 建议修复：无需改动；若产品希望界面提供撤销，hosted 需在 mikka 模式下保留 Undo 并接 onRestore → undoRemoveFact

### [2] 导航与外壳 — 新建任务窗口（创建按钮与 ⌘↵）

- 用户任务：填写任务描述后点击「创建」或 ⌘↵ 新建并派发任务
- 命令：`NewTaskDialog.submit → createTaskOnly / useCoordinatorSubmit`
- 分类：`dead-control` · 层：`hosted`
- 承诺入口：新建任务按钮 / ⌘K 快捷操作「新建任务」→ 窗口底部的「创建」与 ⌘↵
- 实际路径：AppFrame → NewTaskDialog (components/coordinator/new-task-dialog.tsx) → @ui-slot/new-task → .hosted-ui/slots/new-task.tsx NewTask → CreateWindow (.hosted-ui/components/kanban.tsx:765) 的「创建」按钮（只在 busy=sending 时禁用）
- 建议修复：把 canSubmit（或一个 {disabled, reason}）传给 CreateWindow，在缺少 Agent 或附件未上传完时禁用「创建」/⌘↵ 并显示原因（如「选择 Agent 后才能创建」），或让 Agent 有默认值。

### [2] 导航与外壳 — 收件箱（建议）空态

- 用户任务：没有连接任何应用时，在收件箱里连接一个应用以获得建议
- 命令：`InboxPage（hosted 槽） / useSuggestions / onConnect`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：收件箱空态里的「连接应用」入口（public 默认槽 SuggestionFeed 提供，contract 也声明了 onConnect）
- 实际路径：issue-workspace.tsx:875 传 onConnect → @ui-slot/inbox → .hosted-ui/slots/inbox.tsx InboxPage（解构时不接收 onConnect）→ InboxScreen 空态（.hosted-ui/components/inbox.tsx:1254-1255）只有「查看任务」
- 建议修复：hosted InboxPage 用 useConnectedApps 判断没有活跃连接，在空态（或 caughtUp 旁）渲染「连接应用」并调用 props.onConnect；也可以把该动作并入空态文案。

### [2] 导航与外壳 — 新建 Bot 的工作区默认模型 / 仓库

- 用户任务：工作区管理员设置新建 Bot 的默认模型和默认仓库
- 命令：`updateWorkspaceBotDefaults`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：设置 › 常规（或模型与订阅）里可编辑的工作区 Bot 默认值；新建 Bot 窗口读取该默认值
- 实际路径：无：components/、.hosted-ui/、app/、hooks/ 中没有任何 updateWorkspaceBotDefaults 的调用者；桌面 RPC 也只注册了读（bots.getWorkspaceBotDefaults）
- 建议修复：在设置 › 常规（或模型与订阅）加入管理员可编辑的默认模型/仓库，调用 updateWorkspaceBotDefaults（沿用 admin 权限与 botDefaultRepositoryUnavailable 错误）；若不打算提供，则移除新建 Bot 对默认值的读取，避免展示一个不可更改的默认。

### [2] 任务 — Task 创建（看板列内新建）

- 用户任务：在某一看板列里直接新建任务，并让新任务出现在该列对应的状态
- 命令：`createTaskOnly（NewTaskDialog 的 create_only 路径）`
- 分类：`misleading-feedback` · 层：`both`
- 承诺入口：.hosted-ui/components/kanban.tsx:603 的列内 “+” 按钮：aria-label 为 “New task in {column}”，onClick 为 mikka.onNew(column.id)
- 实际路径：.hosted-ui/components/kanban.tsx:603 → .hosted-ui/slots/board.tsx:186（onNew: () => onNew()，column 参数被丢弃）→ components/slots/board-contract.ts:109（onNew: () => void）→ components/workspace/board-page.tsx:273（onNew={() => setNewTask(true)}）→ components/coordinator/new-task-dialog.tsx:185-186（createTaskOnly + backlogTaskDraft）→ lib/task-create-form.ts:12（status: 'todo'）
- 建议修复：让 BoardScreenProps.onNew 接收列 id，board-page 把它传给 NewTaskDialog（新增 initialStatus），并在 create_only 的 createTaskOnly 输入里使用该状态；或让列内 “+” 直接调用带 status 的创建命令。

### [2] 任务 — Task 受阻标记（metadata.block）

- 用户任务：查看并取消自己手动标记的受阻
- 命令：`updateIssueMetadata({block}) / moveIssue`
- 分类：`action-parity-gap` · 层：`both`
- 承诺入口：看板卡片右键菜单的 标记受阻 / 取消受阻（components/blocks/kanban-board-1/components/kanban-board.tsx:207）；卡片点开后的任务页应能看到并取消同一状态
- 实际路径：看板写入：components/workspace/issue-board.tsx:144-152（changeBlock → updateIssueMetadata patch.block）。任务页：components/workspace/task-detail-frame.tsx:244-289 的 rows 没有 block 行，components/workspace/issue-detail-actions.tsx:169-192 的 ⋯ 菜单没有标记/取消受阻项；moveIssue（app/actions/issues.ts:431-440）只写 status，不清除 block。
- 建议修复：在任务页的 rows 或 ⋯ 菜单增加 受阻 项：显示 blockLabel，切换 metadata.block（FLAGGED_BLOCK / clearedBlock(runId)），复用看板的 updateIssueMetadata 写入。

### [2] 任务 — Task → Project 关系（已归档项目）

- 用户任务：把任务移入某个项目
- 命令：`moveIssueToProject`
- 分类：`state-model-drift` · 层：`both`
- 承诺入口：任务页 项目 行菜单（components/workspace/task-detail-frame.tsx:235-241）与项目对话框（components/workspace/issue-metadata-controls.tsx:138-148）列出的项目
- 实际路径：getIssuePropertyOptions → listWorkspaceProjects（app/actions/issue-metadata.ts:50；app/actions/projects.ts:79-81）→ accessibleProjects（lib/project-access.ts:104-122，未过滤 archivedAt）→ taskProjectOptions 原样列出 → 选中已归档项目 → moveIssueToProject 对目标项目 requireProjectWrite({allowArchived:false})（app/actions/projects.ts:184）→ 抛 projectArchived（lib/project-access.ts:84）
- 建议修复：在 getIssuePropertyOptions 的 projectRecords（或 taskProjectOptions）过滤 archivedAt，让已归档项目不出现在任务的项目选择器中（恢复后才可选）。

### [2] 任务 — Task → Project 关系（只读项目）

- 用户任务：把任务移入某个项目，或把任务移出当前项目
- 命令：`moveIssueToProject`
- 分类：`permission-mismatch` · 层：`both`
- 承诺入口：任务页 项目 行菜单 / 看板卡片右键 项目 编辑器
- 实际路径：accessibleProjects 返回 canEditProperties:false 的项目（lib/project-access.ts:119），getIssuePropertyOptions 丢掉该字段（app/actions/issue-metadata.ts:54），选择器照常列出 → moveIssueToProject 对目标项目和原项目都要求 canSteer（app/actions/projects.ts:194-197）→ lockResourcesAccess 拒绝并抛 issueNotFound（lib/resource-access/store.ts:82）→ UI 显示 “This task does not exist or you do not have access.”（app/actions/projects.ts:230 + messages/en.json 的 Errors.issueNotFound）
- 建议修复：在 getIssuePropertyOptions 里保留 canEditProperties，并在任务项目选择器中过滤或禁用不可 steer 的项目，给出准确原因；对当前项目不可 steer 的情况也说明无法移出。

### [2] 聊天与线程 — 线程运行位置（ThreadRunPlace / getThreadMachine）

- 用户任务：在打开的线程里看清它跑在哪台机器上（Mikka Cloud / 自己的电脑 / SSH server），悬停看机器状态、sandbox ID 并复制
- 命令：`getThreadMachine`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：docs/design/thread-run-location.md（已接受的规格：标题右侧的运行位置图标 + 悬停卡片「Sees where a thread runs … right after its title」）；components/slots/thread-header-contract.ts:35 把 place 定为必填属性
- 实际路径：components/workspace/issue-thread-panel.tsx:662 传入 place={<ThreadRunPlace …/>} → components/workspace/thread-header.tsx:4（re-export @ui-slot/thread-header）→ .hosted-ui/slots/thread-header.tsx:103 的 ThreadHeader 不解构 place，header 行里也不渲染；该文件里唯一会画机器的 MachinePlace（:167）只被 ThreadStatusLine（:186）使用，而 ThreadStatusLine 全仓库无人挂载
- 建议修复：在 hosted ThreadHeader 的标题后渲染 place（或在 transcript 上方恢复 ThreadStatusLine），保留 MachineDetails 的悬停卡片；若确实不跟，就删掉 ThreadHeaderProps.place 和 ThreadRunPlace，别留下死代码。

### [2] 聊天与线程 — 线程上下文用量（ThreadContextUsage / getIssueThreadContext）

- 用户任务：看一个线程的 brief 占了多大上下文、离折叠阈值还有多远
- 命令：`getIssueThreadContext`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：components/workspace/thread-context-usage.tsx:21（「What the run holds, in the thread's status line」，带 估算/分段 popover）与 IssueThreadDetail.context（app/actions/agents.ts:388-395）
- 实际路径：没有任何路径渲染。bb65cbf30 从 components/workspace/issue-thread-panel.tsx 的活动行里删掉了 estimate 的 SWR 读取和 {context && <ThreadContextUsage usage={context} />}；此后全仓库没有组件 import ThreadContextUsage，getIssueThreadContext 只剩 lib/desktop-rpc/registry.ts:77 与测试引用
- 建议修复：要么把 ThreadContextUsage 恢复到活动行（用 data.context，或恢复 historyPage 后的 estimate 读取），要么连同 getIssueThreadContext、ThreadContextUsage、IssueThreadDetail.context 一起删除，别留下半套。

### [2] 聊天与线程 — 回复活动分组（thinking 被当成工具计数）

- 用户任务：看懂一条回复折叠起来的活动行到底做了什么、用了几个工具
- 命令：`getCoordinatorChat`
- 分类：`misleading-feedback` · 层：`hosted`
- 承诺入口：hosted 线程用「读了 3 个文件，跑了 2 条命令」概括一组工具（.hosted-ui/slots/thread.tsx:299-303 的 words.tools）
- 实际路径：components/coordinator/coordinator-chat.tsx:621 → useThreadToolRows（components/coordinator/reply-activity.tsx:279-289）把 thinking 行放进 tools 数组第一位 → .hosted-ui/slots/thread.tsx:214 原样转成 tool 行 → .hosted-ui/components/agent-thread.tsx:1861 无条件 <ToolGroup> → :1927 threadWords.tools({ count, labels }) → .hosted-ui/slots/thread.tsx:349-355 的 toolKinds 把「思考中/已思考」归为 other
- 建议修复：hosted 渲染时把 thinking 行从 tools 数组里拆出来单独一行，或让 toolKinds/words.tools 跳过 id === 'thinking' 的行并把它作为前缀文字。

### [2] 跨页面一致性 / 设置 › 模型与订阅 (hosted Models 页) — API key / model（队友共享的凭证）

- 用户任务：在 Models 页关掉一个不想再用的模型（包括队友共享的 key 带来的模型），并知道为什么关不了。
- 命令：`setModelEnabled / getEnabledModels`
- 分类：`permission-mismatch` · 层：`hosted`
- 承诺入口：Settings › Models 中每个模型行右侧的启用开关
- 实际路径：.hosted-ui/slots/settings-models.tsx 组装 providers → .hosted-ui/components/settings-models.tsx:449-457：开关 disabled={mikka.modelSaving || mikka.modelDisabled(m.id)}，只有一个 aria-label={m.name}，没有任何可见原因；同一模型在 优先使用的模型 里是可派发的候选。
- 建议修复：对来源不属于本人的模型（enabled.data.sources 里没有该 source）显示凭证所有者与「只有所有者能改」，或干脆不渲染开关；provider 组标题对共享 key 用 key 的 provider/所有者名称而不是 head.name。


## 严重度 1（10 条）

### [1] 设置 › 模型与订阅 — 模型开关 › 全开/全关

- 用户任务：一次性开启或关闭某个来源的全部模型
- 命令：`setAllModelsEnabled`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/acceptance/self-hosted-batch/enabled-models-api.md:12
- 实际路径：无 UI：.hosted-ui/lib/models/enabled.ts 只暴露 setModel；provider 卡头只有计数（.hosted-ui/components/settings-models.tsx:418-420），没有批量开关；唯一注册处 lib/desktop-rpc/registry.ts:226
- 建议修复：在 provider 卡头的 on/total 计数旁加全开/全关控件，调用 setAllModelsEnabled。

### [1] 设置 › 账号、安全、计费 — 计费 › 历史订阅说明 (legacy_seat)

- 用户任务：历史席位订阅用户确认自己的账单条款仍然有效
- 命令：`getBilling (BillingView.billingModel)`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：billingModel === 'legacy_seat' 且 live 时显示 legacySubscription 说明
- 实际路径：.hosted-ui/slots/settings-billing.tsx:75-105 只渲染 planLine 与 meters, 没有 legacy 说明分支
- 建议修复：Render the same legacySubscription note in the hosted plan card when data.billingModel === 'legacy_seat' && data.live.

### [1] 设置 › 账号、安全、计费 — 用量页读取失败 (usage read error)

- 用户任务：用量读取失败后重试, 不必刷新整个应用
- 命令：`getUsage`
- 分类：`error-recovery` · 层：`both`
- 承诺入口：设置 › 用量读取失败时提供重试 (同页其它 section 都用 SettingsSaveError + 重试)
- 实际路径：components/settings/usage-view.tsx:58 只渲染 `{error && <FieldError>{error}</FieldError>}`; contract 没有 onRetry (components/slots/settings-usage-contract.ts:18-27); hosted .hosted-ui/slots/settings-usage.tsx:61-65 只渲染错误卡与 详情, 同样无重试
- 建议修复：Add `onRetry` to SettingsUsageProps (wire it to `usage.mutate`), and render a retry action in both usage-view.tsx:58 and the hosted error card.

### [1] 设置 › 偏好设置 — user_preferences.sendKey（发送快捷键）

- 用户任务：选择用 Enter 还是 Cmd/Ctrl+Enter 发送消息
- 命令：`updatePreferences`
- 分类：`missing-affordance` · 层：`both`
- 承诺入口：docs/settings-backend/prefs.md:9 — sendKey 取值 'enter' 或 'modEnter'；docs/settings-backend/prefs.md:206-212 描述 sendsMessage 与 composer 的 sendKey
- 实际路径：无写入点。hosted 聊天输入框会读该偏好（.hosted-ui/lib/chat/use-official-composer.tsx:19 读取 settingsRead('preferences').sendKey），但没有任何控件写它；公共层 composer 完全不读 sendKey
- 建议修复：在偏好设置加「发送快捷键」二选一（Enter / ⌘Enter），保存 updatePreferences({ sendKey })

### [1] 聊天与线程 — 回复的思考内容（coordinatorReasoning）

- 用户任务：点开一条已存回复的「已思考」，看模型当时想了什么
- 命令：`coordinatorReasoning`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：components/coordinator/reply-activity.tsx:236-261（「A stored reply knows that it thought … loaded when the person opens it」）与 app/actions/coordinator.ts:211-215
- 实际路径：components/coordinator/coordinator-chat.tsx:621（hosted 分支调用 toolRows(…, { thinking, thought })，从不传 reasoningAt）→ components/coordinator/reply-activity.tsx:279-284（useThreadToolRows 只把 live 的 thinking.text 放进 detail）→ .hosted-ui/slots/thread.tsx:215（detail 为空则 body 为空）→ .hosted-ui/components/agent-thread.tsx:1970（无 body 的 tool 行渲染成不可展开的 div）
- 建议修复：把 reasoningAt 交给 hosted 的工具行（例如 ThreadScreen 的 tools part 增加一个按需读取的回调），或让 hosted 的 thinking 行复用 ReplyActivity 的读取逻辑。

### [1] 聊天与线程 — 聊天上下文用量（CoordinatorContextUsage）

- 用户任务：在主聊天里看这个会话占了多少上下文、什么时候会折叠
- 命令：`getCoordinatorChat`
- 分类：`action-parity-gap` · 层：`hosted`
- 承诺入口：coordinator-context-usage.tsx 的注释「How full the Coordinator's conversation is」；ChatView.context（lib/coordinator/store.ts:235，由 getCoordinatorChat 返回）
- 实际路径：components/coordinator/coordinator-chat.tsx:825 只在 public（embedded）分支的 composer 里渲染；hosted 分支（:667-696）把 composer 交给 @ui-slot/thread，.hosted-ui/slots/thread.tsx 没有任何对应节点，ThreadScreenProps 也没有 context 字段
- 建议修复：在 hosted 聊天里把上下文读数交给 composer 的 mikka（例如放在 modelControl 旁），或在 ThreadScreenProps 增加一个 context 节点由槽位绘制。

### [1] 自动化与外部集成 — 自动化编辑页的主要命令（保存/暂停恢复/立即运行/删除/接手）

- 用户任务：保存、暂停/恢复、立即运行或删除一个自动化
- 命令：`createAutomation/updateAutomation/pauseAutomation/resumeAutomation/runAutomationNow/takeOverAutomation/deleteAutomation`
- 分类：`error-recovery` · 层：`both`
- 承诺入口：这些按钮在成功或返回错误码时会给出 toast（automation-editor.tsx:147,152,163,173,193,195,204）
- 实际路径：AutomationsSection → AutomationEditor 的 save/toggle/runNow/takeOver/remove（components/automations/automation-editor.tsx:139-209）
- 建议修复：给 save/toggle/runNow/takeOver/remove 加 try/catch，catch 中 toast.error(actionError('generic'))，与 cancelRun/restore 保持一致。

### [1] 跨页面一致性 / i18n (设置 › 成员与团队, 任务/项目 团队 行) — Team

- 用户任务：创建或编辑团队、加入/退出团队、把成员加进团队，或在任务/项目上选团队；被服务端拒绝时要知道原因。
- 命令：`saveTeam / changeTeamMember / setIssueTeam / setProjectTeams`
- 分类：`misleading-feedback` · 层：`both`
- 承诺入口：团队页、任务详情 团队 行和项目 团队 对话框里的 role=alert 错误行
- 实际路径：hooks/settings/use-team-directory.ts:64,192,214 与 components/teams/issue-team-control.tsx:58、components/teams/project-team-control.tsx:53 直接把 result.error 存进 state；.hosted-ui/slots/settings-members.tsx:164,359,440 与 .hosted-ui/slots/task-detail.tsx:604 原样渲染，于是界面显示 teamArchived / workspaceAccessDenied / teamPersonalWorkspace 这样的原始标识符。
- 建议修复：在 useTeamDirectory / useTeamForm / useTeamMembers 里用已有的 translateError(result.error)（与 useInviteMembers 一致），并让 app/actions/teams.ts 与 app/actions/team-relations.ts 的 result() 像 workspace.ts 那样把 WorkspaceError code 翻译后再返回。

### [1] 跨页面一致性 / 任务状态 (web vs mobile) — Task status

- 用户任务：看一个任务现在处于什么状态（看板、任务详情、手机上），读到的应该是同一个名字。
- 命令：`n/a（纯呈现，无服务端命令）`
- 分类：`state-model-drift` · 层：`both`
- 承诺入口：看板列头/卡片、任务详情属性行与状态菜单里的状态名（Issue.status.*）
- 实际路径：apps/mobile/features/tasks/screens/task-screen.tsx:165 用 BOARD_LABEL[task.status] 作为状态行的文字，BOARD_LABEL 来自 apps/mobile/features/tasks/components/task-icons.tsx:21 的 MobileCore.board；任务列表的无障碍标签（task-list.tsx:128）同样用它。
- 建议修复：让手机端状态文案复用 Issue.status.*（或把 MobileCore.board 并入同一组 key），并对齐大小写与 backlog/done 的措辞。

### [1] 跨页面一致性 / 设置 › 运行环境 (非管理员) — Run environment / project default

- 用户任务：为项目选择默认运行环境，或至少知道为什么自己改不了。
- 命令：`setProjectDefaultEnvironment / saveEnvironment`
- 分类：`permission-mismatch` · 层：`both`
- 承诺入口：运行环境页「项目默认」每行的环境选择器
- 实际路径：components/settings/environments-settings.tsx:87 在 !data.canManage 时把「添加」整个隐藏，:107 的 Select disabled={!data.canManage || pending}，页面没有任何说明文字（SettingsSection 无 description，messages 的 Settings.environments 也没有 admin-only 文案）。
- 建议修复：在 !canManage 时给该 section 一行可读说明（例如「只有管理员可以修改运行环境」），与审计日志页的处理保持一致。


## 有意为之（12 条，不修）

- **个人访问令牌 (personal access tokens)** — 创建/查看/撤销给 CLI 与 API 用的个人访问令牌
- **免费额度 / 验卡 (card verification and free allowance)** — 验证银行卡以领取免费额度
- **计费 › 订阅/付款/充值动作** — 管理套餐、付款方式、发票与充值
- **Organization / Governance 槽位（PUBLIC_CONTRACT_SLOTS）** — 打开「组织」与团队治理页
- **device_tokens 手动签发** — （不存在）手动为某台电脑生成一个配对 token
- **~/.ssh/config 主机列表** — 在添加设备时从本机 ~/.ssh/config 一键选择远程主机
- **手动添加记忆（addFact）** — 手动告诉 Mikka 记住一件事
- **Task 归属 / 个人范围** — 把工作区任务改为个人任务并确认 Linear 外部副本风险（已退役）
- **Task Team 创建 / 升级** — 在某个 Team 下新建任务；把已有任务挂到 Team
- **Linear 集成设置页（设置 › 连接 › Linear / 插件 › Linear）** — 连接 Linear，并判断同步为什么不可用、能否恢复
- **设置 › 连接 中未连接的自家集成（Linear、Telegram、GitHub）** — 在设置 › 连接 里找到并连接 Linear / Telegram
- **cancelAutomation** — 永久取消一个自动化

## 被反驳（2 条，原判错误）

- **E2B key status read** — 查看自己是否已配置 E2B API Key 以及最近一次校验错误
- **自动化编辑页 ·「运行后发到 Slack」** — 为自动化选择 Slack 通知频道

## 复现方式

```sh
# 重新跑完整审计（复用缓存）
# 脚本：/Users/alexjiang/.claude/projects/.../workflows/scripts/mikka-action-coverage-sweep-wf_9db87011-f4b.js
```

单条验证：

```sh
node --test scripts/interaction-policy.test.mjs scripts/entity-ui-policy.test.mjs
pnpm lint:ui
```
