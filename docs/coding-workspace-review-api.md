# Run workspace Diff 与本地 Review API（#1722）

状态：后端基础实现，尚非 #1722 完成声明。依赖 #1721 的 Run 精确工作树身份与按需 daemon RPC。UI #1731–#1735 的页面不在本实现中。

Task 页面与卡片的接口适配、检查观察、原子发送和精确候选合并，见
[Task review API](coding-workspace-task-review-api.md)。本页保留底层 Run API 合同。

## 当前可用行为

Linux daemon 从已登记的仓库与精确 Run 工作树读取 working diff，合并 tracked、index 与 untracked 文件；显式 commit 比较使用完整 Git OID。工作区未变化时 snapshot version 稳定，文件自身内容或基线变化时 fileVersion 改变。读取不运行仓库的 filters、外部 diff、hooks 或 fsmonitor，不改 index、HEAD、用户 Git 配置或文件内容。

Git 内建 CRLF→LF 转换以实际 attributes、core.autocrlf 和 index 内容判断；完整 raw 与 clean blob 均验证。自定义 filter/encoding/ident、冲突 index、非普通文件和不支持的 attributes 来源明确不可用。只有完全相同的内容识别为 rename；带内容改动的移动保守表示为 delete/add。

daemon 只传有界 manifest 和完整私有 blob proof；服务器检查 Git object hash、UTF-8、完整源码中的秘密，再构造 patch/hunk。公开响应和数据库不保存 blob/base64 proof。文件最多 1 MiB，patch 最多 512 KiB，manifest 最多 20,000 个文件且 1.5 MiB；限额结果有明确状态，不声称完整。

快照与评论独立于 device/device_repo 的寿命。历史绑定可以由真实 live resolution 建立，也可以从原 Run 仍保留的实际 repository 行、冻结 workspace 与 admission/publication 仓库声明验证后建立。后者不要求旧设备启用或旧 daemon token 有效；调用者 repoId 仅用于相等校验。设备已物理删除且从未冻结绑定时，不能恢复的原 repoId 明确拒绝，不以当前同名仓库重建历史。Task 下同工作区且当前能访问 Task 的成员可读历史；taskless Run 仍仅 owner。live daemon 访问保持 owner 与原 claim-token/device/worktree 身份，不扩大既有 private thread ACL。

## HTTP 合同

路径均位于 `/api/runs/{runId}/workspace/diff`；应用部署的既有 `/mikka` base path 继续适用。每个请求必须传 `repoId`，可显式传 `workspaceId`。认证使用现有 browser session 或绑定 workspace 的 PAT；browser POST 必须同源。所有结果 `private, no-store`。不接受重复 query key 或未知字段。

| 方法与相对路径 | 输入 | 成功响应中的字段 |
| --- | --- | --- |
| `GET /` | `source=auto/working/checkpoint/commit/pull_request`；commit 必须带 `baseSha,headSha`；可带分页项 | `ok,snapshot,boardRevision,files,nextCursor` |
| `GET /{snapshotId}/files` | `cursor,limit=1..100,unreviewed=true/false` | 同上，读取固定 snapshot |
| `GET /{snapshotId}/file` | `path` | `ok,file`，含 format、patch、hunks |
| `GET /{snapshotId}/review` | `cursor` | `ok,revision,snapshot,comments,nextCursor,permissions` |
| `POST /{snapshotId}/review` | JSON `{repoId,workspaceId?,mutation}`，最多 32 KiB | `ok,requestId,revision,action` 与操作回执 |
| `GET /{snapshotId}/github-review` | `cursor?,threadId?` | `ok,review`，GitHub 原生 thread/comment 的独立分页 |
| `POST /{snapshotId}/github-review` | JSON `{repoId,workspaceId?,mutation}`，仅 browser session | `ok,batch`，持久批次与真实发布回执 |
| `GET /{snapshotId}/review-batches` | `batchId?` 或 `cursor?`，二者不能并用 | `ok,batch` 或 `ok,batches,nextCursor`，仅当前人的批次 |
| `POST /{snapshotId}/review-batches` | JSON `{repoId,workspaceId?,mutation}`，仅 Run owner 的 browser session | `ok,batch`，Agent 消息或后继执行的真实回执 |

`auto` 先尝试 owner 当前 live 工作树，再尝试已保留 checkpoint，最后尝试绑定的 GitHub PR。显式 commit 在原工作树不可用时可通过 GitHub 的完整 Git tree/blob 读取；不依赖当前机器。没有相应证据时返回 `availability=unavailable` 及 reason，绝不将旧 gzip patch 当作安全源码，也不编造空 diff。

快照含 frozen Run/repository identity、taskId、source/baseSha/headSha/treeSha/version、observedAt、isStale、availability/reason、counts.complete 与 comparison policy。working 的 treeSha 为 null；HEAD 与临时工作树树对象不可混淆。旧 patch 是历史事实；缓存缺失时不能拿当前文件填充旧版本。

每个文件含 path/previousPath、status、前后 blob/mode/size、fileVersion、additions/deletions/binary 与当前 viewer 的 reviewed/reviewedAt。尚未生成 patch 时 counts 不声明完整。分页 cursor 同时绑定 source version、board revision、筛选模式和位置；变化返回冲突，调用方重新读取第一页。

## GitHub 来源与按需 patch

每次 HTTP 请求的 GitHub provider 绑定当前查看者。普通连接使用同一个本人 token 完成 GitHub 身份、本人与 Mikka App 的 live repository 交集及精确仓库 ID 检查；Cloud 只为该查看者和冻结仓库请求读取凭证。Run owner 只用于查原发布回执，不用于替成员读取私有 GitHub 数据。仓库名称仍相同而数字 ID 改变、撤权、404、403、限流、网络失败都明确拒绝，不返回空文件集合。

PR 只来自精确 `run_publications` host 回执；Factory review/verify Run 沿原 attempt/candidate 找原 producer，不按 Task 选择最新 PR 或候选。快照可携带 `factory={taskId,candidateId,producerRunId,sha}`；实际 PR head 已超出该 candidate 时，不将后继代码标为原 candidate。

GitHub 快照携带 `sourceAccess={kind:'github',repositoryId,manifestComplete:true,pullRequestNumber?,pullRequestBaseSha?}`。它参与整个快照版本，防止 GitHub commit fallback 与相同 SHA 的本地快照去重后丢失权限约束。`pullRequest.baseSha` 是当次 GitHub PR 的目标分支 tip；`revision.baseSha` 是本次完整文件清单与原生 hunk 检验所用的比较基点。两者独立冻结。原生每文件 metadata 含 repository ID、patch SHA-256 和有界页码；页码仅为 locator，不赋予权限，也不影响 fileVersion。

PR 原生文件最多 3,000 个、每页 100；读取全部页，验证 `changed_files`、重复路径、前后页和完整 immutable Git tree 的变更集合。compare API 的 merge-base 只作为候选，不用其最多 300 个 files 代替完整 PR。Git tree 截断、来源矛盾或受保护路径发生变化时拒绝整份 capture；不通过过滤文件制造完整性。`sourceAccess.manifestComplete` 表示文件清单已闭合，`counts.complete` 仍表示所有 patch 已加载且可读；二者不同。

每文件按需读取固定 blob OID，并验证完整字节 hash、大小、UTF-8 和 secret policy。PR patch 必须匹配原生摘要，并逐行验证原生 hunk 的精确旧/新坐标、所有省略的未变区间及 EOF；无法证明候选基点时该文件明确不可用，不以本地重算 hunk 代替 GitHub anchor。缺原生 patch、binary、symlink、gitlink 和超限文件不产生可评论的伪锚点。前后 PR base/head 变化时返回过期；已安全保留的旧 patch 仍是旧版本的历史记录，读取也必须重新验证当前查看者的 GitHub 权限。

读取有一个请求级 30 秒工作预算、累计请求与字节上限，不跟随 provider URL 或重试。凭据刷新有独立 10 秒 GitHub／20 秒 Cloud 网络窗口；开始前预留完整刷新及保存预算，一旦发送旋转 refresh，先完成有限读取与数据库提交，再响应 UI 取消，避免遗失已经轮换的新令牌。

本地 board/comments 继续按 Mikka Task ACL 留存、读取、回复和修改；不会自动导入 GitHub native body/diff hunk，也不因本地修改触发 GitHub 写操作。新建源码行评论仍需当前源码授权和已验证 hunk。

## GitHub 原生 Review 与持久批次

原生读取使用固定 GraphQL query，一页最多 20 个 thread，每个 thread 一页最多 20 条 comment。外层 thread 与指定 thread 的后续评论分别分页；cursor 绑定 snapshot、完整 sourceVersion、数字 repository ID、PR、观察到的 head/base 和 thread。旧 cursor 不能拼接新 head 的页面。comment ID 保留十进制字符串，拒绝失去精度的数字；返回原 commit、原行号、resolved、outdated、URL，不导入 provider diff hunk。

完整原生正文先经过 owner/viewer 的当前 secret policy，再按 4,000 字符限制返回，并明确 `bodyTruncated`。内存中的私有完整正文验证标记在最终 HTTP 事务中复核；新 secret policy 不能仅重新扫描已截断的片段。

发布 mutation 明确区分 `action=publish` 与 `action=reply`。publish 指定 `event=COMMENT/REQUEST_CHANGES/APPROVE`、本地 `commentIds` 和 note；reply 指定 GitHub 顶层 comment ID 和正文。两者都传 `requestId,expectedRevision,batchId,sourceVersion`。只有当前人的 session 与自己的 GitHub user token 可写；installation token、PAT 或其他用户的连接不能代替。共享 Task 成员可以用自己的 GitHub 权限提交自己可见的评论，但不能选择他人的私有 draft。

准备批次时冻结完整选择集合、锚点、正文、来源与 GitHub account；锁 board、校验 revision、验证完整 source proof，并按 PostgreSQL 实际 JSONB 字节数执行 32 KiB 上限。不截断反馈。重复 requestId 必须保持相同输入；不同 requestId/batchId 的相同语义也返回原批次。唯一例外是已证明未产生效果的 rejected 批次：旧 requestId 永远返回原拒绝；修复原因后，必须用新的 requestId/batchId 与当前 board revision 明确重试。prepared、delivering、uncertain 和 accepted 不能借新 ID 绕过去重。当前 source、PR head/base、连接 token、session 与 workspace 权限在实际发送前再次验证；对应 host publication/candidate 在效果事务中保持锁定，不能将同一快照改投另一个 PR。

一次 publish 只发送一个含全部行评论的 Review POST，使用 `commit_id,line,side,start_line,start_side`，不回退到旧 `position`。回复只支持顶层评论。复用既有 operation ledger：独立提交 invocation gate，外部调用与最终 ledger/批次回执投影保持权限租约；投影失败或 COMMIT 不确定不能被标成成功。此类人的直接操作没有伪造的 execution Run。

网络结果不确定后，只做有界正向 readback；不会再次 POST。Review 必须同时匹配批次标记、完整正文、账号、commit、event，以及完整行评论集合的正文、path 和 original 行坐标，才可转 accepted。marker 一致但少评论、错行、错正文或分页未闭合仍不确认。并发提交者返回同一批次的当前状态；负 readback 不能取消另一个已 claim 请求的首次发送资格。accepted 回执包含实际 GitHub object ID、URL、commit 和来源 head；发送后的 head/base 改变单独记录 outdated。

只有 mutation 请求明确返回非限流 HTTP 4xx，才证明此次写被 provider 拒绝。POST 后的 GET/GraphQL 失败不具有该含义；429、5xx、超时、响应丢失或无法证明完整内容时仍保留 uncertain。错误不包含 bearer token 或原始 provider 私有正文。

## 一次完整 Agent 反馈

Agent mutation 使用 `requestId,expectedRevision,batchId,snapshotId,sourceVersion,commentIds,failedCheckRefs,note?`。Factory 来源还必须带精确 `factory={taskId,revision,attemptId,candidateId,sourceEventId}`；执行中尚无候选时 candidateId 可为 null，但 attempt 必须属于所选原 Run。不能用当前 B attempt 的元组重新解释 A Run 的旧快照。

服务端冻结所有选中评论的完整结构、LEFT/RIGHT 锚点、正文、note、来源 Run/repository/snapshot/base/head/tree/version，以及已验证的检查引用。最多 50 条评论，note 最多 4,000 字符；完整反馈文本最多 10,000 字符，整个冻结输入仍受实际 JSONB 32 KiB 限额。完整内容不能容纳就明确拒绝，不切掉尾部评论。检查引用接受当前来源的 `run-report:<uuid>`、`run-chunk:<uuid>`、本次精确 Factory task/attempt 的 `factory-attempt:<uuid>`，以及 Task Checks API 为当前查看者和精确来源保存的 `github-check:` 引用；GitHub 附件只接受失败项，并冻结服务端已遮盖的日志节选。任意客户端字符串或日志正文不成为检查证据。

投递前重新验证真实 working tree、当前完整 checkpoint，或冻结 GitHub PR/commit 证据。文件清单、完整 blob 身份、base/head 与来源不一致时拒绝，并提示 refresh/rebase。旧源码可继续作为历史查看，但不能借历史回执将后继 Run 当成原 Run。反馈指令要求 Agent 修改前核对原始目标、文件和版本；这是反馈合同，不代表本接口已经提供终端控制权租约或文件写入 CAS。

- 原 Run 仍执行：复用既有 Run message inbox，一批对应一个确定性 message ID，不创建另一个工作进程。
- 原 Factory 执行已结束：校验当前 revision/attempt/candidate/source epoch，复用既有 finish/retry/repair 与 automatic dispatch，保留原目标、阶段和预算约束。
- 普通 thread 的原 Run 已结束：要求它仍为该 thread/Task 的最新 Run，通过既有 Factory admission/queue 创建 continuation，冻结原执行使用的模型与账号选择，不重新选择最新模型。

上述 message/queue、完整反馈附加、worker freeze 和 accepted 批次回执共用一个 APP 事务；事务提交失败不会留下已确认的孤立回执或可领取的半成品 Run。复用现有 profile、权限和 workspace membership 检查。原生 CLI session resume 从已接受批次读取完整反馈，不依赖 Markdown 分隔符截取。正文作为结构化数据加入原请求，不产生额外工具权限；发送前和领取续执行时重新检查当前秘密遮盖策略。

回执 `delivery.kind` 为 `run_message`、`factory_repair` 或 `run_continuation`，带真实 message/attempt/Run ID。accepted 表示请求已原子入队，不表示 Agent 已修复问题或新执行已经成功。明确拒绝的 reason 为 `source_changed`、`authorization_changed`、`target_unavailable` 或 `limit_exceeded`；外部写的不确定结果使用 `delivery_uncertain`。读取回执只返回当前人的状态与对象关联，不返回冻结正文；GitHub 凭据失效不抹掉已有本地历史事实。列表每页 50 个，cursor 绑定 snapshot、sourceVersion 与 board revision。

## Checkpoint 证据与恢复 ACK

复用现有 checkpoint 已生成的 Git tree；不增加工作树扫描、暂存操作或定时器。daemon 从同一受管 clone 批量读取完整旧/新 Git blob，携带独立 `review` envelope。捕获前后 HEAD 不一致、Git 对象不可验证或预算不足时，review 有明确 reason；现有 recovery checkpoint 仍独立判定有效性。

review 的完整 blob 总预算为 4 MiB，单 blob 1 MiB，manifest 1.5 MiB；文件与 patch 的其它限制继续适用。过大的单文件或不支持的 mode 只保留明确不可读的 metadata，不能伪造可评论的 hunk。旧 daemon 可不发送 `review`。设备 POST 的成功 ACK 保持严格 `{runId,takenAt}`，其中时间由服务端决定。

服务器在内存验证完整 proof、Git hash、manifest/file version、Run repository 和 secret policy，丢弃 raw proof 后才写 review。recovery、review 与最新观察指针在同一 APP 事务内提交；review 的预期限额/安全拒绝只回滚 sidecar，并将最新观察设为明确 unavailable，不阻断合法 recovery ACK，也不把旧 good snapshot 当成最新。

相同内容可复用 immutable snapshot，同时刷新最新 observation 时间；新的空 checkpoint 替代旧非空观察。若 secret policy 变化使旧 immutable patch 已无法读取，即使新 proof 内容相同，本版也明确返回 `missing_evidence`，不会无凭据更新旧 artifact 的验证状态。Stop、claim token 变化、设备接管或凭据失效不能覆盖 recovery 和 review 指针。

## 评论、锚点与 Reviewed

`mutation` 使用 `requestId` UUID 与 `expectedRevision`，action 为 `create/reply/edit/resolve/reviewed`。完整类型见 `@mikka/protocol/coding-workspace-review`。

- `create`：body 最多 4,000 字符；默认 draft。anchor 固定 snapshotId、sourceVersion、path/previousPath、LEFT/RIGHT、lineStart/lineEnd 与 hunkFingerprint。仅允许实际 hunk 中该侧的连续可见行，不能跨 gap 或将旧锚点绑定到新 snapshot。
- `reply`：回复本地 thread，保留 thread 的原 snapshot/anchor。不能读取或回复其他人的未发布草稿。
- `edit`：仅作者修改正文；回执保留 before/after 摘要，源码锚点不变。
- `resolve`：root 作者或 Run owner 可改变 root resolved 状态。resolved 与 outdated 是不同事实。
- `reviewed`：批量记录当前 viewer 对精确 path/fileVersion 的标记，文件版本改变即失效，其他未变化文件不被清空。

board row lock、评论写与幂等 receipt 在同一事务。相同 requestId 和内容重放返回原回执，即使 expectedRevision 已过期；同 requestId 改内容则冲突。草稿仅作者可见，published 本地评论对当前授权成员可见。当前不会把本地 published 标记解释为已发到 GitHub。

新评论/Reviewed 写复用现有 run/issue invalidation；GET 不主动发送 invalidation，页面订阅既有 live 事件，不添加轮询。

## 完整源码与撤权边界

完整 proof 校验时使用真实 Run owner 的全部 workspace/repository/personal secrets、适用 E2B keys 及凭证模式。每个持久化 patch 保存该检测集合与规则版本的服务器内部 keyed fingerprint；它不会返回客户端。密钥集合变化后，只有 hunks 的旧 artifact 无法重新证明整份源码安全，读取明确拒绝。不能靠逐 hunk 检测绕过横跨两个 hunk 的多行 secret。

daemon receipt 到公开读取之间，同样比较 full-proof 校验时与返回时的指纹；不允许旧校验结果被新策略重新认证。新密码不会被发送给 daemon。读历史响应在远端等待完成后重新进入短事务，锁定真实 session/PAT、workspace、active membership、Task 和 Run；最后策略检查与同步响应生成也保持这些锁。撤权与 Task 移动不能仅凭进入请求时的鉴权继续返回内容。评论正文在写事务内用 owner 和当前作者的策略遮盖，提交前策略变化会回滚写入。

每个 Run 最多保留 50 个 snapshot、16 MiB patch。只淘汰没有评论、delivery batch 或最新 checkpoint 引用的 observation。评论和回执有显式总量限制。workspace/account 正式删除流程清理新增表；共享 Bot 的保留规则沿用既有历史归属，不让某位 reviewer 离开时删除其他成员评论。

## 兼容与待完成范围

Files capability 继续为 `x-mikka-coding-workspace: 1`；Diff 独立使用 `x-mikka-coding-workspace-diff: 1`。旧 Files daemon 在 SQL LIMIT 之前排除 Diff command，不能让不认识的 command 阻塞 Stop。

checkpoint producer、GitHub whole-PR/commit 来源、原生 review/reply、普通 Run/Factory 反馈与批次持久化已实现；真实 PG17/HTTP 回归以当前提交的 CI 结果为准。生产 E2B 与 native CLI 的完整闭环仍须实际验收，不能将 provider mock 或 schema/接口存在视为已通过生产 E2E。

验证入口：`pnpm test:coding-workspace-diff` 为纯 proof/anchor/撤权回归；daemon 的 `coding-workspace-diff.test.ts` 使用真实临时 Git 仓库；`pnpm test:coding-workspace-db` 在隔离 PostgreSQL 17 中覆盖 persistence、真实 session/PAT/member ACL、评论与真实 TCP API→daemon→receipt 链路。没有数据库时的 SKIP 只证明入口可加载，不算数据库通过。

`github-delivery.db.test.ts` 保留真实批次、ledger、加密 GitHub 连接与权限事务，只替换上游 GitHub 网络；覆盖一次性发布、并发去重、未知结果恢复、撤权、私有草稿、超限和提交故障。`test:approved-writes-db` 的 ledger 子例覆盖无 execution Run 的 session 效果与原子投影。模拟 provider 的数据库测试不等于真实 GitHub 发布验收。

`agent-delivery.db.test.ts` 使用真实 Git proof、批次、session/member 权限与 message inbox，覆盖完整多评论、去重、漂移、秘密变化、撤权、SQL/COMMIT 故障和修复后的显式重试。`test:factory-checks-db` 的 profile dispatch 套件覆盖实际 Factory repair 与普通 continuation 的模型、prompt digest、后继关系、过期元组和事务回滚。无数据库时的加载结果仍仅为 SKIP。
