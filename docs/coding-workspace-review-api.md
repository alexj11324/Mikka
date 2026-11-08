# Run workspace Diff 与本地 Review API（#1722）

状态：后端基础实现，尚非 #1722 完成声明。依赖 #1721 的 Run 精确工作树身份与按需 daemon RPC。UI #1731–#1735 的页面不在本实现中。

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

本地 board/comments 继续按 Mikka Task ACL 留存、读取、回复和修改；不会自动导入 GitHub native body/diff hunk，也不因本地修改触发 GitHub 写操作。新建源码行评论仍需当前源码授权和已验证 hunk。GitHub native threads 和发布/回复将使用独立的授权与明确发布回执。

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

本基础版还需完成并验证：GitHub native review/reply；普通 Run/Factory 的反馈批次与 durable delivery receipt；生产 E2B 与 native CLI 场景。checkpoint producer、GitHub whole-PR/commit 来源与持久化已实现，真实 PG17/HTTP 回归以当前提交的 CI 结果为准。相关 schema/接口预留不能视为功能已经可用。

验证入口：`pnpm test:coding-workspace-diff` 为纯 proof/anchor/撤权回归；daemon 的 `coding-workspace-diff.test.ts` 使用真实临时 Git 仓库；`pnpm test:coding-workspace-db` 在隔离 PostgreSQL 17 中覆盖 persistence、真实 session/PAT/member ACL、评论与真实 TCP API→daemon→receipt 链路。没有数据库时的 SKIP 只证明入口可加载，不算数据库通过。
