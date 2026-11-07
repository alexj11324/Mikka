# 禁用八路径准备器恢复版

## 结论与限制

这是新恢复版，不是旧 prepare-a65-cache.py 的字节恢复。仅在 /vercel/recovery/disabled-preparer-recovery 写入代码与离线证据；没有网络、生产登录、模型、SQL、Git refs/index 写入或控制激活。
源仓库只通过 git show/cat-file/rev-parse/ls-tree/diff-tree/merge-base 读取不可变对象；预测 overlay tree 用 Git 对象规范纯哈希计算，不调用 write-tree/hash-object -w。

固定 acceptance 输入 fcce5474bc35d8f353458b44561ed1f6d3b175f8 / tree bbb6791d8a1fb2add72b3639223dbdd64161c33d。
固定恢复 checkpoint 344fafb353d1128f89475bc827a404eff4520451 / tree be51d6c30d873f1785d6239fe92e4099cbde7352，唯一 parent 必须 fcce，差异必须恰四路径，每个源码 SHA256 固定。
这四个恢复 driver/test 已独立完成原 fcce RED→14/14 GREEN；本次没有重复这些测试。

## 恰八个输出路径

1. scripts/acceptance/issue-1506-alex/coordinator-ordinary-stop.mjs
2. scripts/acceptance/issue-1506-alex/stop-completion.test.mjs
3. scripts/acceptance/issue-1506-alex/coordinator-tool-stop.mjs
4. scripts/acceptance/issue-1506-alex/tool-stop-no-boundary.test.mjs
5. scripts/acceptance/issue-1506-alex/live-source.mjs
6. .github/workflows/issue-1506-alex-continue.yml
7. scripts/acceptance/issue-1506-alex/LIVE-ACCEPTANCE.md
8. .github/workflows/issue-1212-mcp-reply.yml

前四个逐字来自 checkpoint。live-source 仅替换应用 commit 和两个已审 pin，loader 算法不变。continuation 仅替换 source checkout 并添加新 no-boundary test 到既有离线命令。LIVE 文档明确下一阶段是 cache6、四个固定 warm 槽≤3000ms，不声称新的 live/React/性能成绩。MCP 原稿可完整从 fcce 恢复：只把原26ef SHA清空，保留 literal false、12min、原reader/cleanup和授权配置；没有重造MCP业务driver。

continue.json 不在输出范围，完整保留 enabled=false / phase=tool / expectedSha=null / cacheTurns=3；during_tool 不变。presence 仍 literal false + empty SHA。旧 resume 的 workflow/control 均逐字保留，control没有enabled，不能借这次准备触发它。原MCP四支持文件、legacy目录、receipts等共19个保护对象均核原SHA，并由只覆盖八路径的base-tree构造保持。

## 源码检查

要求未来应用完整40位commit、实际tree精确匹配，且已审产品83d236和两个引入提交是应用祖先。
十项source pin与decoder逐字哈希检查；未知漂移拒绝，不自动接受实际新值。

允许的两项精确变更：
- components/coordinator/coordinator-chat.tsx：f0bb1d01… → 53ff7f4491b9749d0c0cfa6f4b2b55c49d0af8441be2e336331489963a684473；引入ad224。
- lib/swr/persistent-cache.ts：d1e65d58… → b7750de029f5462bee61efba2642ccfa894e08a981a75c97f5852e715b5f9b1f；引入a65。
- decoder保持490572a956f7675c1305f15394d75e1f6634cf3440da17fb3376dfb5189cf4e4，acceptance原decoder也核同值。

review_1495 的独立0c组合检查：465aae7的十pins/decoder与83逐字相同；43fef只追加两测试，runtime相同。其完整原source-proof复制为peer-source-proof.json，SHA997affe4d985371a9866bfa8bd14e3a40840fd4323b852f32f000bcdcf31e453。该兼容证明不替代未来实际merge/source/部署检查；准备器也不声称覆盖所有未列为pin的业务源码。

## 已执行的离线检查

python3 test_prepare.py：7/7 PASS，无skip；原log与receipt保留。
覆盖：四文件overlay的预测tree恰等于真实checkpoint tree；八路径/字节/disabled/独立模型命令保护；错误应用tree；未知source pin；decoder漂移；checkpoint字节漂移；错误激活/control/stopcase/presence/MCP/legacy字段。
offline-preview-83.json/.patch仅以已存在83对象作测试输入，文件明确notActualMergedOrDeployedApplication=true；没有执行真实未来merge输入，没有上传该预览。
原生产失败分母、旧日志/parser/aggregate均未重写。当前没有可恢复的schema3 aggregate完整源码或已知store key，不能沿旧hash冒充恢复。

## 后续唯一入口（当前未执行）

python3 /vercel/recovery/disabled-preparer-recovery/prepare.py \
  --repo /vercel/Mikka \
  --application-sha <未来实际merged应用40位SHA> \
  --application-tree <该实际Git tree> \
  --output /vercel/recovery/disabled-preparer-recovery/actual-<唯一标签>

output必须是本目录下全新子目录；所有检查通过后才写入payload八文件、tree-overlay.json、candidate.patch和manifest.json。任何失败不得自动换SHA/pin或复用半成品。输出永远是disabled-only，deploymentVerified/activationAuthorized均false；生产READY与是否授权单独激活由root核验。

## 未来禁用push的预期

若root后续把这八路径作为一次普通提交更新active acceptance：continuation workflow会因自身yaml变化启动，但只可进行checkout/setup/control校验及always artifact步骤；source checkout、离线harness、Infisical与Haiku/Luna业务步骤均受enabled输出为true限制而skip。artifact设置if-no-files-found:ignore，不能保证disabled调用产生JSON。
MCP workflow也因yaml变化被选择，但整个observe job literal false，凭据/reader步骤不执行。
presence与legacy resume的触发路径没有变化，不应由本次八路径diff启动；其内容与控制均原样。没有任何自动“下阶段”授权。
