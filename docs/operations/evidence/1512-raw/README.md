# #1512 隔离调用链的原始证据

本目录保存固定提交 `1a54dcc0434369e99816c3cf3f6861da19eba125` 的完整安全 JSON 报告。它是隔离环境的证据；不表示生产、真实模型、官方 CLI、E2B、浏览器或 Replay 已验收。

## 文件完整性

- 文件：`isolated-trace-chain-1a54.json.gz`，标准 gzip，176,493 bytes。
- gzip SHA-256：`f8f0d45065dad4605b9017d6737d53c98bf75cff9d4aeae772328418b305d6c0`。
- 解压后的 JSON：6,340,268 bytes。
- JSON SHA-256：`0b8dd25b47093fe5344d48d834889bf91d5685f24b825b4f624d21a42ae9fced`。
- 压缩前后字节已按摘要核对；gzip 固定时间字段以便复核。

## 真实与合成边界

运行环境为云 Linux、Node 24.22.2、独立 PostgreSQL。HTTP API、durable Workflow、source daemon、CodexAdapter、claim/lease/MCP 与 Git clone/worktree/commit/push 均实际运行。模型、订阅、GitHub API 和 Codex app-server peer 是明确的合成边界，真实 provider generation 为 0。隔离资源已结束并回收。

| 固定用例 | Run ID | Trace ID |
| --- | --- | --- |
| 成功 execute | a9a30657-bc68-443f-a4c8-5ea8c12c85a8 | 388ebf700e67f8a19c745aeb44973e0d |
| 受控失败 | 02935750-d755-4554-b0be-061460aa7b74 | a13813aa2ce5396caf26d911d8952e95 |

这两个固定用例通过各自断言，包括预期失败的 ERROR span 和关联 Logs。最终 collector 收到 8,064 spans、1,484 logs、34 synthetic generations；privacyViolations/malformed/dropped 均为 0。

报告也保留之后一次超出 execute-only fixture 的 Factory review 失败 `SYNTHETIC_DELIVERY_CONTEXT_REQUIRED`。因此报告不证明完整 Factory review 或正式 Artifact acceptance；这些仍由真实生产验收完成。

本证据分支用于保存报告与控制代码历史，不是部署分支。实现和后续结果以 [PR #1518](https://github.com/alexj11324/Mikka/pull/1518) 与 [issue #1512](https://github.com/alexj11324/Mikka/issues/1512) 为准。
