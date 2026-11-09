# 官方 Claude 根证书重新链接：2026-11-09 定点证据

这份记录供模板维护者核对两条 Claude 证书规则的来源。
[官方对照 run 42661569263 / attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42661569263)
在未安装 Mikka、未执行模型或 CLI 的条件下，观测到两个打包普通文件在
fresh 阶段变为精确的 provider 根证书引用。mode 和 uid/gid 未变化；证据
支持两条 Claude 作用域规则，不代表全盘保全、私有候选或生产验收通过。

## 原件绑定

本轮来源与原件核验结果如下：

- 产品源码 `623a1afd8715433a58c3e88ce88f8fbcc29d1761`，tree
  `193c7c1a101a56a889f7b22eb615e903981942af`。
- 控制提交 `7fd8a2681cd71bb6603a485854c8beda2044911b`，sole parent
  `32d3afecbeb1f8d433f9a91c51f3980995207d30`，tree
  `e7152cf5bd7b348f92904d9aa7ea87ec5e532a83`；九个变更路径与固定来源守卫一致。
- 实际 push actor/triggering actor 均为 `alexj11324`；job
  `129314204150` 的观察、独立清理和上传步骤全部成功。
- 绝对窗口为 2026-11-09 17:07:29–17:22:29 UTC，四阶段都在窗口内。
- Artifact `13694766815`，ZIP 2310 B，SHA-256
  `4e16df73b5ed7acfe366449d278b20e1fa20d0033ba2998f9741e7755cf0eb09`。
  下载字节与 GitHub artifact digest 一致，ZIP CRC 校验通过。
- `claude.json` 为 10322 B，SHA-256
  `1e53cae8e0b3feaec3d0454429cc7d89e2ad89f2694b77f72e323a7bb076fff6`；
  `summary.json` 为 1273 B，SHA-256
  `adbc2d857de6efd7eb47fa74cd7c41a964954faee6f0439877e0a02fd5eb1cc5`。

[完整结构化证据](1782-official-claude-certificate-relinks-20261109.json)
保留这两个 artifact 文件的全部 JSON 值、四阶段元数据、资源身份和清理，
另含实际 GitHub 来源信息；它是结构化导出，不冒充 ZIP 内文件的字节副本。
导出为 18164 B，SHA-256
`dc69062c8376cb2a10cf47b7455ff478f7872c709c31c128c1384ecfc7696632`。

## 四阶段实测

两条引用的 before、pre_finalization、ready 原 SHA-256 均为：

`4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1`

各路径的变换如下；三节点在四阶段均为 mode 0777、uid/gid 0：

| 路径 | before / pre_finalization / ready | fresh |
|---|---|---|
| `/etc/ssl/certs/1560546e.0` | 普通文件，4e04… | 链接，原始 target 精确为 `e2b-ca.pem` |
| `/etc/ssl/certs/e2b-ca.pem` | 普通文件，4e04… | 链接，原始 target 精确为 `/usr/local/share/ca-certificates/e2b-ca.crt` |
| `/usr/local/share/ca-certificates/e2b-ca.crt` | 普通文件，ee836… | 普通文件，0459… |

根证书 before/pre/ready SHA-256 为
`ee836ee305e23a18319640cafe0c7ebe628d7fbf985c23cfc5bf453d2ea7224d`；
fresh SHA-256 为
`0459a4cfe2cc288afae322259a84a08910e65282d89dc06e94f5e1b80d3c6cb4`。
fresh 两条完整链分别经过第一条引用→第二条引用→固定根路径，以及第二条
引用→固定根路径。两个 terminalSha256 都等于同阶段根普通文件的实际 SHA。

四阶段 UTC 时间如下：

| 阶段 | 时间 |
|---|---|
| before | 17:08:42.919622490 |
| pre_finalization | 17:08:43.373407703 |
| ready | 17:08:51.379865480 |
| fresh | 17:09:01.280188819 |

before/pre 的 boot ID 为 `7b9a053b-b8c9-4695-a917-6f9e44b41f2d`；
ready/fresh 为 `48a38586-20df-42ad-8b89-aa4a7b0af701`。证据不借用
Desktop 的根证书 SHA，也不证明任何 Codex 变换。

## 规则与回归范围

以产品 623a1afd 为基线，规则文件只追加两个 `templates: ["claude"]`、
精确 4e04… 原 SHA、精确 raw target、`providerRoot: true` 的条目，不含
mode 例外。原 320 个条目保留；common、其他模板和既有控制证据保持。
`official-files.py` matcher 没有修改。

strict 安装保全仍拒绝相同的 file→link 变换。只有显式 finalization 才能
使用这两条规则，并实时检查终点为固定根路径的普通文件。receipt 保留
strict 安装摘要、原始/归一化摘要、条目数与 policy SHA；receipt 中的
resolvedSha256 不会代替实时文件系统校验，也不会独立重建链路。

离线新增四个用例组，覆盖本轮 Claude 正例、错误基线/target/身份/路径、
错误终点和 receipt 篡改。原 29 个测试方法全部保留。唯一过期的
“Claude 拒绝同一 4e04… 变换”断言改为“Claude 仍拒绝旧 Codex a351… 基线”；
其他原负例和 Codex mode 拒绝断言保持。

同一测试源码在旧 policy 上实际 RED：33 个测试中，原 29 个全部通过，
三个新增方法产生 2 个 error 和 6 个 subtest failure。追加两条规则并同步
policy SHA 后实际 GREEN：33/33，0 skip。该结果是离线回归，不是生产验收。

## 资源清理与验收边界

本轮只分配一个私有模板和一个 fresh instance，模型调用、Mikka 安装命令
均为零。`claude.json` 的 probe 为 `observed/complete`，不是仅以最后一份
cleanup summary 推断观察成功。

实例 `iui98zldpl4fxszi3c2nv` 按精确 ID 确认缺席；模板
`ivedr9vpyweketvct677` 的精确 ID 状态为 absent。观察步骤后的清理和独立
always-cleanup 均为 complete、errors=[]。原结果保持
`targetedOnly: true`、`releaseAccepted: false`、`policyChanged: false`。

两条规则仍须由含该 policy 的完整私有候选执行全盘保全、HTTP、Next、
Vite HMR、PTY 和暂停恢复验收；本对照不替代正式 CI、模型、发布或生产门槛。
