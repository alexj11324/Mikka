# Git 与代码审阅设置

来源：Alex 的 #2956 P5；基于 P1 通用设置注册表。此记录说明实现边界，验证结果随同一 PR 更新。

## 写入与存储

个人与工作区 PR 默认值是标题前缀、分支前缀、自动合并、draft。四项均经 P1 的字段 guard、权限、继承和 reset；使用新增类型化 `pull_request_defaults` 表保留执行侧快照。个人 null 回落到工作区，再回落到产品默认值。默认标题前缀为空，分支前缀为 `mikka`，auto merge 与 draft 为 false。

分支前缀只改变新任务的分支命名；任务标识仍来自现有个人前缀或团队 identifier。已有任务复用首个 publication 的分支。local admission、cloud admission、publication 使用同一解析，凭据、远端、任务和 branch 的绑定不放宽。无新增 project 语义。

代码审阅配置是工作区管理员写、成员读：模型（空值沿用既有个人授权模型选择）、严重度阈值、忽略路径、评论或只汇总。标量配置也经 P1，存入类型化列。审阅仓库列表单独保存标准 repository key 和 enabled；只能选择当前工作区已有安装的仓库。

## 执行

现有 `lib/code-review` 是共享合同和前端适配；独立审阅的执行者为 Factory checks，GitHub 事件的可靠触发和任务队列为 schedules。本项复用这些执行者及既有模型路由，不新增模型客户端、轮询或独立审阅工作流。仓库开关不跳过既有 Factory 必需的独立审阅或验收门槛。

PR 草稿默认值不能把失败验证变成 ready。核对 main 发现 `publicationGate` 对 verify=failed 直接跳过发布；保留这个更严格门槛，并让 draft 决策本身也对失败返回 true。Factory 缺少预设验证命令的既有语义保留；用户选择 draft 始终有效。

auto merge 使用 GitHub 原生队列与已有任务/GitHub 身份权限；draft、验证未通过或 Factory 独立审阅未通过不能自动合并。设置不能伪造审批、绕过仓库保护或替另一个人发出有权限的合并请求。

## 重叠与迁移

核对 open #2825：`run-publications.ts` 只增加 publication 完成后的 workflow wake；合批必须保留它，不另造 wake。P1 的共享 registry、schema、store 在本分支增量扩展，生成路由由 generator 生成。

迁移用 UTC generator 分配，只新增表、列、索引，实际执行后冻结文件。回退应用时保留新增数据；旧应用忽略默认值，不回写旧任务分支。自动审阅或 auto merge 的既有外部动作不能由数据库回退撤销，须先停止新触发并检查已排队动作。

## 验证责任

继承与 guard 由 registry 单元测试覆盖；接口用真实 PG17 覆盖未认证、跨工作区、普通成员写管理员字段和个人主体不可替换。publication 使用实际 provider seam 验证命名、草稿及 auto merge 的授权和拒绝路径；不调用真实 GitHub 写入或模型。Factory/schedules 使用既有本地隔离数据库测试边界；CI、实际运行与仍未验证的部分分别记录。
