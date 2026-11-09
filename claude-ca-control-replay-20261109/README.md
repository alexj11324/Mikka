# Claude CA 控制值只读 replay

结论：真实旧规则拒绝两条 alias 的 file→link；候选规则接受这两条变化及原有 root CA per-boot 摘要变化。此次只回放已归档的三个路径，不是全盘保全、CLI 验证、订阅或新的官方控制。

## 绑定

- 原始控制：run 42661569263 / attempt 1；Ops commit 7fd8a2681cd71bb6603a485854c8beda2044911b。
- 不可变证据提交：f845bd90fee2b34a53677d868c45b906a46375ef。
- 本地输入：`/workspace/scratch/263e36984c81/Mikka-1505-ca-relinks/docs/operations/evidence/1782-official-claude-certificate-relinks-20261109.json`，18164 B，SHA256 dc69062c8376cb2a10cf47b7455ff478f7872c709c31c128c1384ecfc7696632。
- 由 controls.claude 与 summary 按原排序/缩进恢复的成员，分别匹配原声明的 10322 B / 1e53cae8e0b3feaec3d0454429cc7d89e2ad89f2694b77f72e323a7bb076fff6 和 1273 B / adbc2d857de6efd7eb47fa74cd7c41a964954faee6f0439877e0a02fd5eb1cc5；此次没有读取 ZIP。

## 实际观察与规则

before、pre_finalization、ready 的两个 alias 都为 file，摘要为 4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1；fresh 变为 1560546e.0 → e2b-ca.pem → /usr/local/share/ca-certificates/e2b-ca.crt。三节点四阶段均为 mode 511（0777）、uid 0、gid 0。root CA 从 ee836ee305e23a18319640cafe0c7ebe628d7fbf985c23cfc5bf453d2ea7224d 更新为 fresh 的 0459a4cfe2cc288afae322259a84a08910e65282d89dc06e94f5e1b80d3c6cb4；两链记录的终点摘要与该 root 节点相同。

真实 matcher、verify 与 finalization_policy 均从指定原文件导入。只有 entry 和 Path.resolve 的数据访问被替换为已核归档观测；不访问任何被观察的系统路径。旧规则结果为两 alias false、root CA true；候选三项均 true。生成的 finalization 结果只含 3 个元数据条目，不是对磁盘的扫描，也不是正式发布回执。

原 matcher 字节完全保持，原 320 条证书规则深等。候选仅追加两条 Claude 规则，不含 mode override；finalization 除关联证书摘要和追加这次 control provenance 外，所有旧字段保持。

## 清理

claude.cleanup 与 summary.cleanup.claude 完全相同：status complete、errors []。Sandbox iui98zldpl4fxszi3c2nv 的 absenceConfirmedById 为 true；template ivedr9vpyweketvct677 的最终复核为 absent。私有诊断 build 为 4161f161-aadb-4bf0-a82f-e6970f981e87。这里只核验已有精确回执，没有重新调用 provider 或执行清理。

官方 base immutable template ID、官方 base build ID、envd version 未采集，保持 unknown。

## 执行

- Python 3.12.14；2026-11-09T17:30:32Z 执行一次 `python -B replay.py`，exit 0，stderr 0 B。
- 精确可执行路径、开始结束时间、stdout/stderr 摘要见 execution-result.json。
- receipt.json：13771 B，SHA256 aba59b7ce4af9095694bd6069cee0dc036f2003addf83080e42b930723008155。
- replay.py 的执行时 SHA256：d73fe12b23577df243fe326560cb1f5831e51076dc373cc745fff759917fe765。
- 未修改产品文件、未重跑 34 tests、未创建资源、未做 Git/ref/归档操作。
