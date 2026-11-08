# Web 群聊创建入口

- **Status:** implemented specification. `components/nav/new-group-dialog.tsx`
  and its focused tests contain the creation flow. Runtime acceptance remains
  tied to the evidence recorded on #1210 and #1209.
- **GitHub:** #1210, #1209
- **Owner thread:** 2026-11-04 生产验收；Web 只有新建 Bot，已有群聊能打开但无法创建。

## What the user does

给群聊起名，选择当前工作区中自己的 Bot，创建后进入群聊。

## Where it lives

Bot list 原有「+」打开两项菜单：新建 Bot、新建群聊。后者打开 Dialog；群聊创建成功后进入已有的中间群聊区域，刷新左侧群聊列表。手机从 Bot list sheet 打开，Dialog 位于 sheet 外，关闭列表不会卸载表单。

## Layout and states

- 普通：群名 Input，Bot 复选列表，取消、创建。至少选一个 Bot；沿用服务端 200 字符群名、100 成员上限。
- 空：没有可选的 Bot；提供新建 Bot，创建群聊按钮禁用。
- 提交中：表单和关闭操作暂时禁用，创建按钮显示 Spinner；30 秒无响应进入未确认状态。
- 明确拒绝：内联错误，保留输入，用户可以修正后提交。
- 结果未确认：保留输入但禁用再次提交，提供查看群聊以读取可能已经创建的结果。没有自动 POST 重试。
- 键盘：菜单、群名、复选项、提交按钮均可操作；取消回到打开入口，成功后由现有聊天视图接管焦点。
- 窄窗口和明暗模式：沿用 Dialog、Field、Checkbox、Button 与 BotAvatar 的现有尺寸和主题；长 Bot 名称截断，成员列表滚动。

## Rules that apply

R-01（Bot list 与群聊）、R-10（复用已有群聊）、R-36（BotAvatar）、R-40（无解释性副标题）、R-51（现有 Bot 编辑入口）、R-82（手机布局）。不新增产品规则。

## Components

新增 `NewGroupDialog`：现有 `NewBotDialog` 创建的是 Bot，无法承担多个 Bot 的群聊选择。复用 `DropdownMenu`、`Dialog`、`Field`、`Input`、`Checkbox`、`Label`、`Button`、`Spinner`、`BotAvatar` 和 `useOpenerFocus`。

## Copy

新建 / New；新建群聊 / New group chat；群名 / Group name；Bot / Bots；没有可选的 Bot / No bots available；新建 Bot / New bot；创建 / Create；取消 / Cancel；关闭 / Close；群聊创建失败 / Group creation failed；群聊创建状态未确认 / Group creation not confirmed；查看群聊 / View group chats。全部来自中英消息表。

## Authority and request boundary

复用移动端现有 `POST /api/conversations`，仅发送当前工作区、群名和选中的 Bot ID。服务端继续验证登录、来源、工作区权限和 Bot 所有权；不新增权限或直接数据库写入。创建群聊不发送聊天消息，不启动 Bot 模型回复。已删除或变更的 Bot 由现有服务端校验拒绝。

## Out of scope

群聊成员编辑、自动邀请其他用户、模型路由、Decision 策略、群聊消息发送、后端权限和生产测试任务。

## Done when

- 从桌面和手机的「+」进入，英文与中文、明暗主题均可完成创建。
- 真实本地 PostgreSQL 和 TestAccountPool 账号通过正常 UI 创建群聊，随后正常 GET 可读到相同成员；跨工作区或他人 Bot 保持拒绝。
- 现有群聊权限和原子写入回归通过，类型、lint、i18n 与 UI policy 检查通过。
- 生产构建后的真实截图绑定精确提交；不使用 API 拦截或浏览器测试套件。
- 任务走查：原入口缺失为严重度 3；修复后可由同一入口选择新建 Bot 或群聊。实际视觉与功能验收结果随 PR 证据记录，未执行的不标通过。
