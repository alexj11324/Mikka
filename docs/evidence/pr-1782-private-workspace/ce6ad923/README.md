# PR #1782 私有 Coding Workspace 验收 — ce6ad923

本目录保留本轮私有候选的独立审计闭集原输出及 root 复核记录。产品为 `ce6ad923bbb449023783052d0848db22e4360f1d`，tree `dffda64a4975b22cfc649908a8c5e19749ea8a96`，worker `638876d7e373115b084b8e56fe69cb437f342f47`。

## 实际执行

- [原完整验收 42761964307/1](https://github.com/alexj11324/Mikka/actions/runs/42761964307)：Ops `7a4ecf17efb555c5bac717c5b1ee2e8d1535bbcd`，job129649516421，SUCCESS。
- [独立只读工件审计 42766445683/1](https://github.com/alexj11324/Mikka/actions/runs/42766445683)：reader `a63a155087ddb3220bfa2952bb8c261d3a7d96d7`，job129663943979，SUCCESS。
- [#1724 本轮主回执](https://github.com/alexj11324/Mikka/issues/1724#issuecomment-6760576095) 包含逐项验收矩阵与原件摘要。
- [#1782 进展](https://github.com/alexj11324/Mikka/pull/1782#issuecomment-6760582521)。

两套 Claude/Codex 派生模板均完成 build、官方安装保全、HTTP/Next/Vite assets、认证/撤权/跨站bootstrap、真实 HMR、PTY 12项功能及负例、5项终端清理、full-memory pause/resume。恢复前后完整 ingress guard 投影相等，IPv4/IPv6与未分配provider port确实执行。四组WebSocket正常1000关闭；6VM及2私有模板逐journal匹配并完成收尾。

## 文件与读取方式

[private-reader.json](./private-reader.json) 是独立reader日志中8,306 B原始闭集JSON串，**无尾换行**，SHA256 `12a92940c32aa71d901079d7e9a4476b861bdb0d1f0e83d679ff6fe8517ce978`。它保留实际观察结果及明确的未覆盖范围；不是原 runner 九份文件的副本。

[root-review.json](./root-review.json) 记录审计来源和 root 实际完成的源码、API元数据、原JSON摘要与逐项投影核验。独立runner实际下载固定ZIP；root从其保全输出读回JSON并再次计算摘要。

原artifact13739141511，5,795 B，ZIP SHA256 `f02b76f05b8b8a2dda6f46fe512293482450f3efb3e2f03b650a5bfef3601701`。三个成员 source.json / verdict.json / receipt-digests.json 全部通过 CRC32、长度和SHA256核验；各摘要见原JSON。

## 证据边界

两台 runtime VM 的 provider 精确复查为 `provider_already_absent`；killAcknowledged与scopeVerified为null，不将它描述成额外kill ACK。七份原runner输入的摘要已核格式与绑定，但reader没有重新下载这些原件。canonical worker由原producer gate计算；reader另核实际产品tree和19文件pins。

这里证明私有派生候选与真实数据平面。正常生产Task权限、正式订阅调用、浏览器iframe以及agent-root隔离需各自证据。本条完成时尚未将 #1782 合并到main，#1724仍保留生产收口项。
