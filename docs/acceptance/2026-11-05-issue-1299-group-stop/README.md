# 群聊 Stop 提交竞争：#1299 / PR #1300

本目录保留隔离 PostgreSQL 的真实红绿记录，证明两个停止状态竞争的最小修复。它不是生产模型验收，也不表示 #1212 的授权轮询迁移已经完成。

## 版本与改动

- [PR #1300](https://github.com/alexj11324/Mikka/pull/1300)
- 应用 head：`8c08893686835c974a1d1ae3e24291da4f77af92`
- PR 父提交：`efef5b5a5a8a55deb3c504b05fb736d4003e942c`
- PR tree：`ab965bdf7851d50f65103a143b75f99a9557d55f`
- 最终实际测试基线：`3adee90c742b045e0eebd5854eecc6ade1c84aae`
- 两个文件：`lib/coordinator/group-turns.ts`、`lib/coordinator/group-turns.test.ts`

`inheritance-proof.json` 证明两个文件在 3ad 和 efef 的原始 blob 完全相同；PR 继承 efef 的其余内容。GitHub tree 与 Vercel 隔离 index 构造的 tree 相等。`tested-manifest.json` 则保留实际 3ad 测试树、逐文件 blob/SHA-256 和各日志哈希。

产品变化是两处最终状态检查：领取必须原子地从 `queued` 转换；私聊发布在现有 conversation 锁内，采用公聊已有的 turn `FOR UPDATE` / `running` 检查。原有权限、列表通知、COMMIT 时机和 `STOP_POLL_MS=1000` 保持原样。

## 如何复现

Vercel cloud Linux、Node 24.22.1、PostgreSQL 17.11，专用 loopback `*_e2e` 数据库。测试用真实 `pg.Client` 执行全部 SQL，只在特定语句的执行/返回边界设置调度屏障；SQL、结果、停止状态均未替换。另一个正常 `handleGroup(resource: stop)` 请求提交成功后，独立 SQL 读确认 `failed / stopped`，才释放 worker。模型 runtime 只返回离线固定文本，无外部模型调用。

最终同一夹具 SHA-256：`ddd16f6d12a80616e0dd3c2e37bc21fe336ecc301cbda2bf1d6c7373fbe3c717`。

| 门禁 | 结果 | 原件 |
| --- | --- | --- |
| 3ad 原产品 RED | 16 通过、两个新增子例失败；Node 另计父例失败，零跳过 | [red-final.log](raw/red-final.log) |
| 修复后群聊相关套件 | 93+5 通过，零跳过 | [green-related.log](raw/green-related.log) |
| 群聊接口/组件单元套件 | 12+12 通过，零跳过 | [groups.log](raw/groups.log) |
| 类型检查 | exit 0 | [types.log](raw/types.log) |
| 两文件 lint | 0 errors / 0 warnings | [lint.log](raw/lint.log) |
| diff 检查 | exit 0 | [diff-check.log](raw/diff-check.log) |

RED 中，正常停止提交后领取路径仍生成并保存 1 条回复；私聊记录从 1 条增加到 2 条。GREEN 中，领取路径为零生成、零回复；私聊保持原有 1 条消息和 link，原停止错误及 trace 原样保留。断言还覆盖陌生成员拒绝、其他群不受影响、取消反馈、新的根消息仍正常执行、没有私聊后继生成。

风险估计见 #1299：领取竞争发生概率 3/10、影响 8/10；私聊发布竞争发生概率 4/10、影响 8/10。这是根据正常并发窗口的估计，没有生产发生频率测量。

## 历史证据与限度

- a18 的最初 RED 和同夹具 GREEN 原样保留。首次私聊计数未按 link 范围过滤，会重复连接同一个 DM 的行（1→4）；它仍证明新消息/link，但最终夹具已改为实际范围计数（1→2），并再次完成 RED→GREEN。
- 导出曾多出一个测试文件末尾空行，`git diff --check` 拒绝；移除后，最终字节文件在 3ad 上重新完成上述红绿与类型/lint 门禁。没有用格式失败冒充产品 RED。
- [integration-3ad.tgz](integration-3ad.tgz) 保存原始整合日志与元数据，包括初次格式检查记录；SHA-256 为 `82ead80ad79ca5bdb95f0830c6d8c377210e55d199e5b8da13c932e6dca60d3e`。
- 本改动没有删除停止轮询、没有建立新的授权源，也没有证明所有运行器在网络故障下的完整 1 秒取消协议。
- 应用 CI、合并、Web deploy、公开 build 和真实生产模型/停止验收，以 PR 与后续生产回执为准；本目录不预报其通过。

## 隔离环境清理

[cleanup.json](cleanup.json) 记录 2026-11-05 01:09:21.965 UTC 普通删除 5 个明确属于本轮的数据库：一个显式目标和四个由本轮原有 Factory 回归创建的 UUID 库。清理前连接数为 0，清理后 `remainingOwned=[]`。未改角色、共享库、共享 PostgreSQL 或沙盒。

首次清理预检把 `inet_server_addr()::text` 的 `127.0.0.1/32` 与裸地址比较而拒绝，发生在任何 DROP 之前；随后实际读取 `host(inet_server_addr())=127.0.0.1` 和端口 5432，保持数据库/角色检查后完成白名单清理。该预检失败也保留。

所有已发布文件的字节数与 SHA-256 见 [checksums.json](checksums.json)。Refs #1299、#1212、#1210。
