# Issue 1505 官方定点控制预制包

此包仅完成本地预制与离线验证，未创建 Git 对象、ref、run 或 VM，未读取凭据或调用 provider。`bundle/` 的三个部署文件已经冻结；实际绑定只由 root 在单独目录完成。

## 最终绑定

- 复用 root 已核验的自有 carrier：`ops/1505-smoke-github-readonly-20261109`，其已关闭 head 为 `e93477fe401c70dca532784e71b76d56877b6899`。不复用旧 C9 child、入口或输出。
- 固定 source：`5ba1f9e2359ce714d83cd16fc040f2567c40a6d0`，tree `a59d2e3ff90594a2625b131ab5a403393715cf40`。
- 未来 operator 只接受精确有序 parents `[5ba1f9e2359ce714d83cd16fc040f2567c40a6d0, e93477fe401c70dca532784e71b76d56877b6899]`；tree 必须以 source 为基底恰新增三个 `100644` blob。保留 carrier 祖先关系，不带入其旧产品/脚本树。
- 独立 GO：`root-reviewed-1505-official-path-control-20261109-v1`。预制 workflow 仍为 `.yml.in`、`if: false`、`CONTROL_GO: 'false'`，两个时间值均为 `UNBOUND`。
- root 负责最后 fresh 核验 source/carrier 并绑定实际时间。本包没有激活证据。

三个部署文件位于 `bundle/.github/workflows/issue1505-official-path-control.yml.in`、`bundle/scripts/ops/issue1505-official-path-control.py` 和同目录 `.test.py`。实际 operator 的 workflow 路径为不带 `.in` 的 `.yml`。文件摘要见 `bundle-manifest.json`。

## 固定来源与必要差分

基础为 [08d822da](https://github.com/alexj11324/Mikka/commit/08d822da081190364530343bf918bbcc2fbbf624) 的三文件官方 Desktop+Codex 四阶段控制；APT 元数据函数来自 [1e351dcf](https://github.com/alexj11324/Mikka/blob/1e351dcfe9a4c93430f8e67fabef5b3dc97385e0/scripts/ops/issue1506-e2b-official-control.py)。原文件逐字保存在 `upstream/`，完整差分为 `candidate.diff`。

变更限于归属/source/carrier/GO，两个模板的采样闭集，禁用时间绑定，以及独立 cleanup 的 workflow 时间空间。旧证书链与 CLI 识别分支已移除；host 和 guest 一并收窄。11 个宿主归属、账本、请求和 cleanup 函数在必要归属/source 字符串归一后与 08d 逐字相同。`window` 仅换为本控制独立 GO；`checkouts` 改为精确双父和三项新增普通文件守卫。Guest 的 `identity/node/command/systemd/main` 与 1e 来源逐字相同。

固定 5ba 的 cleanup helper 与旧来源 111a 整份相同：`scripts/e2b/build-template.py`，55,730 B，SHA256 `0adb53fbdd6cbcd61f1d1804aee3e2df1538997c0724556062f2741c5ac1cdb1`，Git blob `1db4f39b19e83d49404f1df7fd78092d3f9b7ab3`。本地 `source/` 仅保存这一必要测试依赖，不是完整 checkout。

## 观测范围

四阶段为 `before / pre_finalization / ready / fresh`，无人工观察等待。

| 模板 | 路径与输出 |
|---|---|
| Codex | 仅 `/usr/local/share/ca-certificates/e2b-ca.crt`；输出 path/status、kind/mode/uid/gid，以及可稳定读取的普通文件 SHA256。内部沿原 O_NOFOLLOW 与身份稳定读取。 |
| Desktop | 仅 `/var/lib/apt/extended_states`、`/var/backups/apt.extended_states.0` 的原闭式文件元数据；另查询四个固定 systemd unit。 |

四个 unit 为 `apt-daily.service`、`apt-daily-upgrade.service`、`apt-daily.timer`、`apt-daily-upgrade.timer`。服务只取 `ActiveState/SubState/MainPID/ExecMainStartTimestamp/ExecMainExitTimestamp/InvocationID/Result`；timer 只取 `LastTriggerUSec`。命令仅为固定 argv 的 `systemctl show`。

不运行 apt、dpkg-query、产品 installer、CLI 或模型；不停止 timer、不加锁、不扫描全盘、不人为等待。保留原 `exec sleep infinity` 作为 snapshot/instance 生命周期 keeper；它不是计时观察延迟。Fresh sandbox TTL 仍为 120 秒，并立即做精确清理。

`absent / changed_during_read / too_large`、非普通文件或 unit `unsupported` 都只是观测状态；缺少可比较 baseline/hash 不算复现。`probe=observed` 不等于目标变化已复现，不预设实际 R7 首次失败发生在 strict 或 fresh。没有 full-conservation、CLI、订阅或发布通过声明。官方 alias 解析后的 immutable base/build 与 envd 版本若未采集，保持 unknown。

## 资源、清理与 OIDC

上限为两个私有模板、两个 fresh sandbox（每模板一个，2 vCPU / 4096 MiB），共享 600 秒工作预算，900 秒绝对观察窗口。沿用每 kind finally 清理、父进程终止观察进程后清理，以及独立 always-cleanup；cleanup-only 最长 150 秒。20 分钟 job ceiling 与 3 分钟 cleanup step 仅留出收尾空间，不延长 600/900/150 程序预算。

资源 journal 在 build/create 前写入；立即记录 SDK 返回的 template/build ID。Sandbox 必须匹配 exact ID、template ID 和完整本次 metadata，kill 后按 exact ID 验证不存在；模板按本次 alias、ID、private、非 default 和名称核验后 DELETE，再以 exact ID GET 404 确认。未返回 ID 不记为已清理，sandbox 错误不跳过模板清理。

Infisical action block 与固定 08d 逐字相同：同一个 identity `2cf9fa19-b9db-4c08-8ca0-b31859f2cbac`，audience `mikka-infisical`，project `89850d6a-f020-4936-863e-df77380dfe40`，`prod:/vercel` 的 `E2B_API_KEY` 一项，`include-imports:false`。没有添加 `recursive` input，也没有修改身份、授权或凭据。现有 carrier trust 使用 root 已核验事实；本任务未访问身份配置或申请新 subject。

## 离线验证

- 初稿实际 33/33 PASS，后被 root 授权的 carrier/double-parent/独立 GO 绑定更新取代。该次原件与精确三文件快照保留于 `validation/unit-01.*` 和 `validation/iteration-01-source/`，不能混作最终绑定结果。
- 最终绑定实际 **36/36 PASS**，Python **3.12.14**，2026-11-09 17:49:23 UTC，0.141 秒。原件为 `validation/unit-02.stdout.txt`、`.stderr.txt`、`.result.json`。原 26 个非 CLI/证书链测试保留，4 个移除范围的旧测试替换为 7 个闭式采样/资源测试，再新增 3 个 carrier/GO guard 测试。
- AST、embedded guest、YAML、禁用状态、三个文件闭集、OIDC block 与复用函数字节比较全部通过，见 `validation/static-checks.json`。
- 测试使用纯离线假 SDK/API 与临时文件；stdout 中的 deadline/cleanup 行来自这些 fixture，不是实际运行结果。运行环境显式只提供工具 PATH、locale、scratch TMPDIR 和固定 helper 路径。
- `web_wait_review` 对亲读的新 schema、父链 guard、guest 片段及固定上游源码未发现阻断；其环境不能读取整个本地包，未复跑测试。范围详见 `peer-review.txt`。Root 已独立完整读取 workflow 与 observer。

本包不创建 Git 对象或更新任何 ref，也不触发资源或 CI。root 的实际绑定及后续执行均在本包之外。
