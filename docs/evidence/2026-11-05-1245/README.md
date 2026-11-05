# #1245：Codex 现场决定链的生产只读核验

核验时间：2026-11-05 22:13:00.176 UTC。对应[关闭记录](https://github.com/alexj11324/Mikka/issues/1245#issuecomment-6670970856)。

本目录保存一次真实 Neon 只读事务返回的安全投影，补齐现有 Codex 任务中 choose → human answer → redirect → explicit abandon 的运行期身份和来源证据；不是新建任务，也不证明随后文档交付通过。另一条 Claude Code 与 Bot 的完整生产记录见 issue 的[双路对照](https://github.com/alexj11324/Mikka/issues/1245#issuecomment-6670889314)。

- 在线库 orvilo_mvp；transaction_read_only=on；Project、授权 Owner、issue 范围检查全部匹配。
- 一条有界数据 SELECT；4 条决定、7 条来源，各组上限20，均未触上限。
- 三条 Agent 决定发生在真实 run 的开始与结束之间；codex / gpt-6-luna / subscription / codex_cli、native claim、冻结身份及宿主续接回执逐项匹配。
- SID、Owner身份与连接值不输出，仅保留宿主计算的相等/匹配结果；无凭证、prompt、报告全文或原始对话正文。
- 源问题和人工回答、前驱关系、真实 host_verified stopped_at 均保留；后来的 failed/blocked 状态如实保留。

`response-content.json` 是 connector 原始文本内容，18,312 UTF-8 B，SHA256 `4f035baac98dcebb04d599625bd45cf2f38648df9e73a42673ef6fcba5c6b7d2`。`tool-result.json` 是原始返回包装；`summary.json` 是派生摘要。`query.template.sql` 仅将授权 Owner 值替换为占位符，不能当成未脱敏的请求字节。各文件大小与 SHA256 见 `manifest.json`。

上述字节数是证据文本大小，不是 HTTP 传输、PostgreSQL wire 或 Neon 账单流量。没有追加生产请求、模型调用或写入。
