# Failed readonly preparation 42619584651/1

#1505 → #1608 P0：本次只读连接准备失败，已撤销新 child 并关闭入口（12:53 UTC）

- 实际 source `209926afed03da2049d95099f879cc71bb8b8f68`，run [42619584651/1](https://github.com/alexj11324/Mikka/actions/runs/42619584651)，job `129167978484`。源码/窗口门、39 项 helper 测试、普通 frozen 安装和 5 个原有 OIDC→Infisical 步骤通过。
- 正常 Owner token getter 已提交；解析前后保存的 `updatedAt/expiresAt` 一致，不能把这称为独立观察到刷新。源 provider 有效期到 18:59:38 UTC。
- **新 readonly child 已创建，但 post-mint GitHub HTTP 校验失败；没有安装 Smoke 连接。该新 child 的精确 DELETE /token 返回 204。** 没有删除 Owner grant，也没有改原有连接。错误当前仅保留 `provider_http`，还不足以判定哪个 API/状态码；正在修补闭合枚举诊断，不会猜测根因或盲目重跑。
- 入口已正常 FF 到关闭提交 `01ef3fa435380f23fbd3cd7cfbe77839cc5511d9`（唯一父提交 209926a；仅 workflow 的 `if:false`、GO 清空）。关闭 run [42620004596/1](https://github.com/alexj11324/Mikka/actions/runs/42620004596) 已 SKIPPED。
- 我已按前述唯一读取权读取一次 job 原件：56020 UTF-8 bytes，SHA256 `4ac740af94836160ebf949bc48af86ac4cefb7978ff76c145361bba1bbefa11f`。artifact 元数据 ID `13674945658`、ZIP 609 bytes、digest `15fc994c6330a7af543bc328c9d58d0649adb1a2a37bac8525af87f980624964`；未下载 ZIP，不把元数据当作已校验内容。
- 此失败没有产生可供 P0 使用的共享连接。P0 12:29–13:59 硬窗口仍按原回执执行；本方没有延长窗口，新的诊断尝试将绑定当前 main、关闭的 OPS 父提交及新的有限入口。

The complete decoded job log is preserved byte-for-byte as read once by /root. The structured report is extracted from that log; it is not a downloaded artifact member. Artifact JSON contains metadata only. The provider stage/status were dropped by the original helper catch; they cannot be reconstructed from this evidence. No accepted latency sample is claimed.
