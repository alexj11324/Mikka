# 官方 Desktop 根证书重新链接：2026-11-09 定点证据

## 结论与范围

[官方空白控制 run 42628079564 / attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42628079564) 在未安装 Mikka、未执行模型或 SMOKE 业务的条件下，观测到 Desktop 的两个原普通文件在 fresh 阶段变为精确的根证书引用。两者原内容 SHA256 都是：

`4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1`

这份证据只支持新增两个 Desktop 作用域的证书重新链接条目。mode 和 uid/gid 在本轮均未变化；不增加 mode 例外，不修改 Codex 政策，不放宽 strict 安装保全。

## 原件绑定

- 产品源码：`111a8dfb8b227ac0441324339ff42e4328ea609a`。
- 控制提交：`08d822da081190364530343bf918bbcc2fbbf624`，sole parent 为该产品源码。
- Job：`129196946059`；窗口：2026-11-09 13:43:39–13:58:39 UTC。
- Artifact：`13678489689`，ZIP 3748 B，SHA256 `3a51e3a158dbba0fb4c84e658215fec84a032fd155a1514845e522eff476fd4f`。
- 同目录 JSON 是已读取 EXPORT 的逐字副本：26988 B，SHA256 `a438b3315bbd10bf470aed59ccb21fb502ceddc06102e49164eeeb9ca6416d3f`。它同时保留 Desktop 和 Codex 的实际结果及资源清理，不删去阴性或缺失项。

## Desktop 实际阶段

before、pre_finalization 和 ready 的两个引用路径都是普通文件；到 fresh 才出现下表中的两个链接。所有三节点在本轮已存在阶段的 mode 均为 0777、uid/gid 均为 0。

| 路径 | before / pre_finalization / ready | fresh |
|---|---|---|
| `/etc/ssl/certs/1560546e.0` | 普通文件，SHA256 为上述 4e04… | 链接，原始 target 恰为 `e2b-ca.pem` |
| `/etc/ssl/certs/e2b-ca.pem` | 普通文件，SHA256 为上述 4e04… | 链接，原始 target 恰为 `/usr/local/share/ca-certificates/e2b-ca.crt` |
| `/usr/local/share/ca-certificates/e2b-ca.crt` | 普通文件，SHA256 为 3d3bf… | 普通文件，SHA256 为 ffe5cadf… |

根证书原 SHA256：

`3d3bf4eda47ee4754c04202fe5ac919ae609f21aa750de1f6bdc91e83c16a686`

fresh 根证书 SHA256：

`ffe5cadf73f8a4b863034daae2fdd9b861fb32049d2b4d4d68e49282f396b40e`

fresh 的两条完整链分别是：

1. `/etc/ssl/certs/1560546e.0` → `/etc/ssl/certs/e2b-ca.pem` → `/usr/local/share/ca-certificates/e2b-ca.crt`。
2. `/etc/ssl/certs/e2b-ca.pem` → `/usr/local/share/ca-certificates/e2b-ca.crt`。

二者的 terminalPath 都是该精确根路径，terminalSha256 都等于同阶段根普通文件的 ffe5cadf… SHA。before/pre 的 bootId 为 `50814953-5a4b-4c6b-ac6d-006c43034d61`；ready/fresh 为同一个新 boot `a1c080f9-4df6-4532-83ac-1954c9b7fcca`。

Desktop 的 Claude 和 Codex CLI 在四阶段均明确 absent。这里没有原 CLI 存在性或整套 CLI 保全通过的正面证据。

## Codex 的阴性结果

Codex 的 before、pre_finalization、ready 三阶段，三个证书节点全部 absent。fresh 仅出现根普通文件，mode 为 0644，SHA256 为：

`aca6dfe34be5499f55308479809cb236576fe6dc57c991dfed338437879345fa`

两个引用路径仍 absent，链仍为 unresolved。本轮没有观测到 Codex 根证书 0644→0777，也没有复现 Codex 的两个重新链接，因此不据此修改 Codex 根证书规则或原拒绝断言。

四阶段中观测到的 Codex 入口 `/usr/local/bin/codex` 及 canonical 文件 `/usr/local/lib/node_modules/@openai/codex/bin/codex.js` 保持相同类型、mode、属主和内容。该 canonical 文件为 9154 B，SHA256 `e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af`。这只涉及入口和该文件，不宣称整个 CLI 依赖树守恒；没有执行 CLI。

## 限定规则与原保护

补丁以 `8b9dea4b85a9ffe13dab5687774664e1a49a336e` 为基线：

- 证书文件只追加两个 `templates: ["desktop"]`、上述精确 4e04… 基线、精确 target、`providerRoot: true` 的条目；没有 mode 字段。
- 原 318 个条目的序列化内容保持，包含原 Codex a351… 的两条规则；其他模板、common 配置及 Claude 目录规则保持。
- matcher 不变。strict 安装阶段仍拒绝原文件转链接；只有显式 finalization 可使用受控规则。
- finalization 仍要求精确原字节、原文件类型、原始 target 和不变的其他身份字段，并实时检查终点为精确根路径的普通文件。终点根内容允许原有 per-boot 变化，不要求等于旧打包证书。
- receipt 保持原安装摘要、条目数、policy SHA 和稳定摘要关系。receipt 只保存 resolvedSha256，不会重新访问文件系统或独立重建链接链；完整链由本控制的阶段原件提供。

不存在针对整个 `/etc/ssl`、`/var/backups` 的排除，不增加 APT 例外、锁或 timer 变更。下一次正式构建仍执行原 strict 全盘保全。

## 验证与清理

离线原单元入口的 25 个原测试正文逐字保留，包含两处 Codex 0644→0777 拒绝断言。追加四个用例组，覆盖实际 Desktop 变换与原 Codex 规则隔离、错误摘要/target/身份/模板、实时终点类型与路径，以及 receipt 篡改与安装证明替换。

旧政策真实 RED：29 个测试中原 25 个全部通过；新增 Desktop 合法情景被拒绝。追加两个限定条目并同步规则 SHA 后，同一测试文件真实 GREEN：29/29、0 skip、exit 0，完成于 2026-11-09 14:04:02.747256 UTC；测试源码未改，执行前后四源 SHA 一致。该单元结果不是生产全盘保全或发布验收通过。

原控制的两个 probe 均为 observed，清理均 complete、errors=[]。Desktop 实例 `ianfp393mihg4nwxyt50e`、Codex 实例 `ief2bib648u0okshkanj3` 已按精确 ID 确认缺失；私有模板 `z0kyfpyig1td47eqj3gb`、`8dtnoomwg0zwvgfjyc0t` 均为 absent。原结果保持 `targetedOnly: true`、`releaseAccepted: false`、`policyChanged: false`。
