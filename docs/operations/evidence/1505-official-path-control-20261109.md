# 官方 Codex 根证书与 Desktop APT 路径对照

## 结论

2026-11-09 的官方模板定点对照复现了 Codex 根证书文件从 `0644` 到 `0777` 的权限变化。首次观测变化在 `pre_finalization` 与 `ready` 之间；当时证书摘要仍相同，随后 fresh 实例中的证书摘要发生每次启动变化。期间没有安装 Mikka，也没有执行 CLI、模型或全盘文件扫描。

Desktop 的两个 APT 文件在四次采样中的完整节点元数据均相同，四个 APT systemd unit 的已采字段也全部相同。这是未复现结果，不能据此给 Desktop 添加保全例外，也不能排除采样间隔之外的系统写入或未采集的进程。

对应完整、安全、可重建原件的 [JSON 证据](1505-official-path-control-20261109.json) 包含三个原始成员、独立核对结果及入口关闭信息。它不是发布或五秒启动验收。

## 执行身份与观察边界

| 项目 | 实际值 |
|---|---|
| Run / attempt | [42670291715 / 1](https://github.com/alexj11324/Mikka/actions/runs/42670291715) |
| Job | `129344720782`，全部步骤成功 |
| Ops commit | `b75871ea1753f75769daa33b095704475cf9a4a2` |
| Ops tree | `5f87962642912f59980c71748093ffd4f73e10a5` |
| 第一父 / 产品源码上下文 | `5ba1f9e2359ce714d83cd16fc040f2567c40a6d0` |
| 第二父 / 已关闭载体 | `b52445d24978dc46235b0744783eb7ebb3c3e397` |
| SDK | `e2b==2.62.0` |
| 官方入口 | `Template.from_template('codex')`、`Template.from_template('desktop')` |
| 有界窗口 | 18:01:26–18:16:26 UTC；工作预算600秒，清理复查150秒 |
| 资源上限 | 两个私有模板、两个120秒TTL fresh实例 |
| 额外文件 | 仅 `/opt/mikka` 下的观察器与四阶段 JSON |

相对固定产品源，operator tree 仅新增三个普通文件，第二父只保留已关闭的本任务载体历史。工作流使用原有 OIDC 身份读取 E2B key；没有读取 SMOKE 凭据，没有改动 main、Web、生产设置、官方文件、APT 或 timer。

观察器仅读取 Codex 的 `/usr/local/share/ca-certificates/e2b-ca.crt`；Desktop 的 `/var/lib/apt/extended_states`、`/var/backups/apt.extended_states.0`；以及 `apt-daily.service`、`apt-daily-upgrade.service`、`apt-daily.timer`、`apt-daily-upgrade.timer` 的固定属性。没有额外等待来延长采样，也没有读取其他目录。

未采集官方模板的 immutable base template/build ID 或 envd 版本。输出的私有 template/build ID 不能冒充上游 base 身份。控制实验阶段名称不构成其他 R7 构建首次失败阶段的证据；实际 R7 仍须分别核对安装后的 strict、ready 和 fresh 检查。

## Codex：精确文件权限转换

四个样本都是同一根证书路径、普通文件、uid=0、gid=0。

| 阶段 | 权限 | SHA256 |
|---|---|---|
| before | `0644` | `713ed37b92f312cf89345677c1d7f413c55b38ca0c1c636ce0fecc672d08ed9a` |
| pre_finalization | `0644` | `713ed37b92f312cf89345677c1d7f413c55b38ca0c1c636ce0fecc672d08ed9a` |
| ready | `0777` | `713ed37b92f312cf89345677c1d7f413c55b38ca0c1c636ce0fecc672d08ed9a` |
| fresh | `0777` | `545244c4bc7f902ed9a6d843dd6ccaed08d0a59bbfc1b60064bd0278e026da5a` |

before/pre 的 boot ID 相同；ready/fresh 的另一个 boot ID 相同。证据支持为 Codex 该 root file 增加精确 `0644→0777` finalization 转换，配合现有每次启动证书摘要规则。它不支持其他路径、类型、所有者、权限对或 Desktop APT 例外。安装后的 strict 检查、官方 CLI 原件摘要、真实订阅及发布门槛继续保留。

## Desktop：本次未复现

| 节点 | 四阶段共同内容 |
|---|---|
| `/var/lib/apt/extended_states` | 普通文件、`0644`、uid/gid=0、64336B；SHA256 `da850c564cb1797d4ccea654530605994986e9a81497d9f47fa8497504e89347` |
| `/var/backups/apt.extended_states.0` | 普通文件、`0644`、uid/gid=0、64273B；SHA256 `52f87bdad074b319ed8b601e4c5e97ab0d5ce235bafac3213d32f1873f7413ac` |

每个节点的 device、inode、mtime、ctime 也都未变。两个 service 为 inactive/dead、MainPID=0、启动/退出时间 `n/a`；两个 timer 的 LastTriggerUSec 保持各自历史值。没有采集 cron 进程或实际写者 PID，不能由四个 APT unit 的静止状态断言所有系统进程都未写过。

## 原件与清理

Artifact `13697989038` 的 ZIP 为3353B，SHA256 `2aa02beb720a3e3922bafa5ba81344529a22e76ea14588717de0f9e11255b268`。Root只下载一次，检查ZIP CRC、成员集合及无重复成员，再逐项验证闭集schema和清理记录。JSON证据中的 rawMembers 用原 `sort_keys=True, indent=2` 和末尾换行序列化，可恢复下面的精确成员字节。

| 原始成员 | Bytes | SHA256 |
|---|---:|---|
| codex.json | 3405 | `c0ce123a741c24d69d5dc686a4d429d3e72b6e5b46380f2ff37696c1bf761357` |
| desktop.json | 10487 | `57c5c0311f8870840491e87c7b7babc5922015c87f3b266614cf25fca4f217d9` |
| summary.json | 1640 | `c00574e265b2935a3b598714b978eb11732309b24471717b6a3bb64e6ab93ffe` |

Codex 模板 `dfkgci7cyrpu3lxurfja` 和 Desktop 模板 `itr4vtex1pbr2lh6a10v` 均已按 exact ID 确认 absent。实例 `idhdaiwdpb5mu9rga5nx3`、`i60s51yizx5bykzpp83df` 均有 exact-ID absenceConfirmedById；两个分项及汇总的 cleanup 均 complete、errors=[]。入口正常 FF 关闭至 `376298951e4eee5970e2f0d00e21acb3ffba4e18`，关闭 run `42670790551` SKIPPED，canonical ref 已核对。

首轮 `42668993157/A1` 因离线测试预期缺少 repository guard 而失败，35/36测试通过；SDK、OIDC、观察和清理步骤全部SKIP，没有实际云资源。修正断言后，第二版相同36个离线测试通过，再进入上述真实对照。两次结果均保留，不用后来的成功覆盖首轮失败。
