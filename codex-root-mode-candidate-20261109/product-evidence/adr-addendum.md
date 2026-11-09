
### 2026-11-09：Codex 根证书权限的官方定点对照

在同一个 #1505 修复 PR 中继续保留“只许加、不许删或覆盖官方文件”的决定。
主线 `5ba1f9e2359ce714d83cd16fc040f2567c40a6d0` 的 R7
`42661874195/A1` 报告 Codex 根证书权限与 Desktop APT 备份摘要变化；
两者分别归因，不能将已证的 Claude 重链接行为扩展到其他路径。

新的 [官方定点对照 42670291715/A1](https://github.com/alexj11324/Mikka/actions/runs/42670291715)
仅从官方 codex/desktop 模板在 `/opt/mikka` 添加观察器，不安装 Mikka、
执行 CLI/模型、修改官方文件或 APT/timer，也不追加全盘扫描或等待。
Ops `b75871ea1753f75769daa33b095704475cf9a4a2` 的有序父为固定产品源
`5ba1f9e2359ce714d83cd16fc040f2567c40a6d0` 与已关闭载体
`b52445d24978dc46235b0744783eb7ebb3c3e397`，产品树仅增加三个普通文件。
完整原件、安全投影及边界见
[对照说明](../../operations/evidence/1505-official-path-control-20261109.md)
和[可重建 JSON](../../operations/evidence/1505-official-path-control-20261109.json)。

Codex `/usr/local/share/ca-certificates/e2b-ca.crt` 在 before/pre_finalization
均为普通文件、uid/gid=0、0644；ready 时变为0777而摘要仍相同，fresh
时保持0777、证书摘要随后变化。这提供了不含 Mikka 安装的正向证据，
仅支持 Codex 该普通文件的精确 `0644→0777` finalization 转换。
策略继续使用现有 matcher，保留原每次启动 CA 摘要语义、同一路径、
同一类型、未变所有者及 SHA256 格式校验，原有证书重链接目标校验不变；其他权限对、路径和类型
仍须拒绝。安装之后的 strict 检查与官方 CLI 原始摘要门槛不变。

Desktop 的 active/backup APT 节点在四阶段的摘要、大小、权限、所有者、
inode、device、mtime/ctime 全部相同，四个 APT unit 的已采属性也未变。
本次没有复现 Desktop 问题，因此不增加该路径例外。未采 cron 或写者
PID，不能从四个 unit 的静止状态证明所有后台写入均已排除。此前失败
仍保留，后续须定位实际构建首次变化阶段与写入者。

本对照未采 immutable 官方 base/build ID 或 envd 版本，私有输出 build
不能代替它们；控制的四个阶段名也不等于其他 R7 的失败阶段。两个私有
模板和两个实例均有 exact-ID 不存在的清理收据、errors=[]。入口正常
FF 关闭至 `376298951e4eee5970e2f0d00e21acb3ffba4e18`，关闭运行
`42670790551` SKIPPED。首轮 `42668993157` 的离线 guard 断言失败
及其 SDK/OIDC/观察全跳过事实一并保留；后来的成功不覆盖历史失败。

这些定点证据不替代三个官方模板的完整文件与 CLI 保全、两个真实订阅
CI 发布门槛，也不替代同一 APP/DPL/runtime/worker/template 元组下
Claude×3、Codex×3 的生产普通任务、工具与后续回复验收。#1505 仍须
六次完整 dispatch→agent 时间各不超过5000ms，目标2000–3000ms。
