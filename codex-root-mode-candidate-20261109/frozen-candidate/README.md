# Codex 根 CA 文件精确 mode 规则候选

基底是 PR #1835 固定提交 `8197a48843f9733a775003898ab00eaceb533c66`。四个输入文件的 Git blob、字节数和 SHA-256 均与本地只读输入核对；绑定见 `source-bindings.json`。本目录没有创建 Git 对象或更新 ref，没有读取远程日志或 ZIP，也没有启动 VM、调用模型或访问提供方业务接口。

## 可集成结果

`candidate.patch` 仅修改以下两文件，均已冻结：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `scripts/e2b/e2b-finalization-files.json` | 6238 | `7d3abc6a73cfd56ee2bed51572db5b7d0e842db91df838f5dc40563b8c0ceb9c` |
| `scripts/e2b/official-files.test.py` | 61113 | `2e6cf363425489783afda7a53e627d4eb2645a2bba27869378bcd3aed4423dff` |

产品变化仅为 Codex 的 `/usr/local/share/ca-certificates/e2b-ca.crt` 增加 `_kind: file` 和 `mode: {before: 420, after: 511}`，即普通文件 `0644 → 0777`；沿用原有 `sha256: per-boot`。同时追加本次官方定点对照的 provenance，绑定根侧准备的 `docs/operations/evidence/1505-official-path-control-20261109.json`，31,180 字节，SHA-256 `ba526b6e177f786d4dcb62f17c6f84c08c93a1b963fe8a06af49d849f1f2bad0`。该证据文件及 ADR/README 由根侧集成，不包含在本两文件补丁中。

`official-files.py` 和 `e2b-certificate-relinks.json` 逐字未改。逆向删除新增 provenance、`_kind` 和 mode 项后，整个政策恢复原字节。Claude、Desktop、common 和既有 322 条证书规则保持不变。这里保留的是 SHA-256 格式和原有精确重链接终点约束，不是 X509 内容验证。

## 实际验证

使用 Python 3.12.14，只执行四个新方法和四个直接相关的旧方法。完整命令、源哈希、stdout/stderr 与退出码分别保存在 `evidence/*.result.json` 和对应文本文件中；调用入口是 `run-selected.py`。

- **RED**：原政策、原 matcher、原证书表，加新测试及两处必要的旧负例维护。共 8 个方法，6 个通过，2 个出现错误；unittest 共记录 3 个错误，分别来自实际 `ready`、`fresh` 形状和基于该形状构建的 receipt。均明确拒绝 `mode 420 → 511`，exit 1。
- **首次 GREEN**：同一套测试，加入精确政策后 8/8 通过，exit 0。原件保存在 `green-before-comment-clarification.*`。
- **最终 GREEN**：仅将一处注释的 “Codex-only control” 改为 “official Codex observation”，准确说明 Codex 是双模板控制中的一个实例；无测试逻辑变化。同 8 个方法再次全部通过，最终源哈希见 `green.result.json`，exit 0。

新回归覆盖真实控制中 before/pre 的 `0644`、ready 的同摘要 `0777`、fresh 的新摘要 `0777`；严格安装验证仍拒绝这些改变，finalization receipt 必须保留有效的严格安装证明。负例覆盖其他 mode pair、uid/gid 改变、原目录/链接类型、文件替换为目录/链接、其他路径、原 Codex CLI 同时变化、伪造 receipt 和 Desktop backup 的合成摘要变化。

原 34 个测试方法全部保留。其中只有两处原来拒绝新近已证 `0644 → 0777` 的负例，正常维护为拒绝未观测的 `0644 → 0755`；另有注释澄清。新增 4 个方法后总数为 38，本任务没有重跑全部 38 个方法，也不声称全仓 CI 或生产验收通过。

`evidence/red-official-files.test.py` 是在最终注释澄清后通过唯一注释逆变换恢复的 RED 测试源，完整字节哈希与 RED 执行时记录的源哈希一致。它不是新增测试执行。最初有一次把全部源码嵌入 exec 参数的 materialization 调用被参数长度限制拒绝，进程未启动；随后改为按固定 blob 核对本地字节再复制，没有更改测试或产品语义。

## 对照绑定与限制

本地成员来自根侧唯一读取并校验的 run `42670291715` / attempt 1，operator `b75871ea1753f75769daa33b095704475cf9a4a2`，source `5ba1f9e2359ce714d83cd16fc040f2567c40a6d0`，artifact `13697989038`。这里只读了根侧已解包的三个 JSON 成员和 `artifact-verification.json`；成员字节数/SHA、身份、四阶段精确根文件形状及两份精确 cleanup 回执已独立核对。详情见 `review-receipt.json`。

Codex 首个观测到的 mode 差异在 `pre_finalization → ready`，uid/gid 保持 0。Desktop 两个 APT 节点及四个 unit 的四次观测全部相同，所以没有添加 Desktop 规则。官方上游不可变 base/build/envd 身份未采集，继续记为未知；私有输出模板和 build ID 不能替代它们。

这些测试使用实际观测值调用真实 matcher/receipt validator，并用元数据 fixture 替代读取 `/etc` 等文件；不是一次完整文件系统保全扫描。官方定点控制也没有运行 Mikka installer、CLI、模型或真实订阅。四个控制阶段名称不能直接证明另一次 R7 的首次失败阶段。

## 顺序分析

`phase-analysis.md` 记录固定 5ba 源码的严格检查、ready 和 fresh 顺序，以及 Desktop 仍未复现时的最小阶段取证建议。该建议没有实施，也没有新增发布门槛。
