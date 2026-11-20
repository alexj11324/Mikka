# Git 与代码审阅设置

来源：Alex 的 #2956 P5；基于 P1 通用设置注册表。此记录说明实现边界，验证结果随同一 PR 更新。

## 写入与存储

个人与工作区 PR 默认值是标题前缀、分支前缀、自动合并、draft。四项均经 P1 的字段 guard、权限、继承和 reset；使用新增类型化 `pull_request_defaults` 表保留执行侧快照。个人 null 回落到工作区，再回落到产品默认值。默认标题前缀为空，分支前缀为 `mikka`，auto merge 与 draft 为 false。

分支前缀只改变新任务的分支命名；任务标识仍来自现有个人前缀或团队 identifier。已有任务复用首个 publication 的分支。local admission、cloud admission、publication 使用同一解析，凭据、远端、任务和 branch 的绑定不放宽。无新增 project 语义。

代码审阅配置是工作区管理员写、成员读：模型（空值沿用既有个人授权模型选择）、严重度阈值、忽略路径、评论或只汇总。标量配置也经 P1，存入类型化列。审阅仓库列表单独保存标准 repository key 和 enabled；只能选择当前工作区已有安装的仓库。

## 执行

现有 `lib/code-review` 是共享合同和前端适配；独立审阅的执行者为 Factory checks，GitHub 事件的可靠触发和任务队列为 schedules。本项复用这些执行者及既有模型路由，不新增模型客户端、轮询或独立审阅工作流。仓库开关不跳过既有 Factory 必需的独立审阅或验收门槛。

PR 草稿默认值不能把失败验证变成 ready。核对 main 发现 `publicationGate` 对 verify=failed 直接跳过发布；保留这个更严格门槛，并让 draft 决策本身也对失败返回 true。Factory 缺少预设验证命令的既有语义保留；用户选择 draft 始终有效。

auto merge 使用 GitHub 原生队列与已有任务/GitHub 身份权限；draft、验证未通过或 Factory 独立审阅未通过不能自动合并。Factory 尚在审阅时复用已有 publication 工作流等待，进入交付时重新验证当前候选 SHA、独立审阅与既有 evidence。设置不能伪造审批、绕过仓库保护或替另一个人发出有权限的合并请求。关闭设置会阻止尚未交给 GitHub 的自动合并；GitHub 已确认接收的队列不会由此撤回。保存的设置是新运行的默认值，不是外部队列取消操作。

自动审阅保存到现有 schedules。每次分发与受控 `github_call` 均重验当前管理员身份、同一工作区、仓库安装、配置所有者和运行人、启用状态；改为普通成员、转移所有者、暂停、删除或移除安装后，旧请求不能借旧配置继续使用该能力。请求里的 host marker 和实际 occurrence 保留来源绑定；删除配置不会把旧请求降级成无限制 GitHub 调用。

`summary` 模式在现有受控 GitHub MCP 入口拒绝写工具；`comments` 只允许绑定仓库和 PR 的 COMMENT review 及其待发布行评论，不能 approve、request changes、merge 或写别的 PR。工具只读属性取自原生 GitHub MCP catalogue，工作区 deny 和调用人身份仍先检查。该边界覆盖 Coordinator 的 `github_call`；工作线程另保留原生 readOnly 策略。按照既有决策，原生任务仍能读取自己的 GitHub 凭据并使用已有网络，因此本项不声称网络范围内绝对禁止写入，也不引入网络限制或凭据代理。

自定义分支使用协议中的同一个安全任务分支 schema，经 admission、daemon assignment 和签名 workflow result 解析；具体 branch、owner、workspace、任务及 repository 的相等验证不变。新 daemon 用既有 capability header 模式声明接受自定义 `github.branch`。旧 daemon 保留已支持的 `pushBranch`，自定义前缀时省略不兼容的可选 `github.branch`，走既有 native push 与服务端 PR 发布。冻结的已发布 daemon fixture 不修改。

## 重叠与迁移

核对 open #2825：`run-publications.ts` 只增加 publication 完成后的 workflow wake；合批必须保留它，不另造 wake。P1 的共享 registry、schema、store 在本分支增量扩展，生成路由由 generator 生成。

迁移用 UTC generator 分配，只新增表、列、索引，实际执行后冻结文件。回退应用时保留新增数据；旧应用忽略默认值，不回写旧任务分支。自动审阅或 auto merge 的既有外部动作不能由数据库回退撤销，须先停止新触发并检查已排队动作。

## 验证责任

继承与 guard 由 registry 单元测试覆盖；接口用真实 PG17 覆盖未认证、跨工作区、普通成员写管理员字段和个人主体不可替换。publication 使用实际 provider seam 验证命名、草稿及 auto merge 的授权和拒绝路径；不调用真实 GitHub 写入或模型。Factory/schedules 使用既有本地隔离数据库测试边界；CI、实际运行与仍未验证的部分分别记录。
