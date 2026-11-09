# A024 worker 依赖边界：只读设计与窄 peer

结论：可以采用作者当前“同 release 私有 workspace + 仅投影 importer 区块”的最小候选；固定源码层面未发现新增阻断。这里没有重跑安装或构建，也没有将作者尚在完成的 stage 验证写成通过。原整个 root importer 被注入的问题不能靠忽略 workspace 规避，因为实际 A024 的 overrides/patch/build policy 都在 workspace YAML 中。

## 实际源码与候选

输入是 A024 / tree001315。审阅 helper 4,990 B、SHA c6c4d4ff4a2b4dba37a458f632565267fb7feb648f5b0e23113e9ccfbc504119；bootstrap 12,114 B、SHA bada7b22a750386a49824057751150526d59eb9c5056d5dd9d09531e6cf68455。两者是作者提供的稳定本地候选，尚未在本报告中赋予最终 commit 身份。固定 Git 文件与精确 pnpm distribution 的 bytes/blob/SHA 在 source-index.json。

## 为什么保留原 workspace 配置

根 package.json 的 packageManager=pnpm@10.34.3、engines=node24.x，以及完整 pnpm 字段应保留；应用 dependencies/devDependencies 与根脚本不进入私有 worker 根。原 pnpm-workspace.yaml 必须原字节复制，保留 overrides、patchedDependencies、allowBuilds、minimumReleaseAge、minimumReleaseAgeExclude 和 pmOnFail，patches 目录同步保留。A024 没有 .npmrc/.pnpmfile.cjs；本结论不替未来新增配置声称支持。

作者已用实际 A024 证实 --ignore-workspace 报 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH。精确 pnpm.cjs:19077–19106 也说明 root package 配置和 workspace 配置是两条读取路径；只指定 lockfile-dir 不等于保留 workspace 配置。

## 锁投影的独立比较

本 reviewer 只调用原 builder 的纯 lock_projection 与候选纯 project_lock，没有执行 pnpm。原锁 978,174 B，派生锁 943,429 B；7 importers 变为一个空根和 config/protocol/daemon 三个原 importer。三个选中块全部相等；lockfileVersion/settings/overrides/patchedDependencies/packages/snapshots 全相等。

原依赖指纹投影前后字节相同，SHA256 均为：

5fcda28bf43db78880c6a41a112988a622cf59ae22d39db041adffef68be7571

原图包含 411 个 package 条目和 414 个 snapshot。不要自行裁掉看似来自 root 的已锁 peer context：daemon 与 protocol 的 Vitest 分别绑定 OTel1.9.0/@types-node24.19.2 和 OTel1.10.0/@types-node25.9.9，且原图保留 happy-dom、yaml 等 peers。config 的 eslint/^10 和 typescript/^6 也有真实 peer 声明。三个原 package.json 必须完整复制，不能只摘 dependencies。

pnpm10.34.3 的 frozen 路径先验 settings/manifests，然后 headlessInstall；缺依赖或完整性错误在 frozen=true 时直接失败，不进入新解析。headless 按选中的 importer 走锁图。因此保留完整 packages/snapshots 并不等于安装整个 Web 根依赖。原 build-template 的 lock_projection 是哈希文本而非合法安装 YAML，不能直接当新锁写出。

## 解析器与实现复杂度

当前 pnpm 自身捆绑 js-yaml，但它不是公开稳定的独立模块；所查 Node/npm 与 pnpm 安装路径没有可直接使用的外部 yaml/js-yaml。没有必要为投影额外下载一套解析环境，或从 pnpm bundle 内提取函数。

本次接受的窄边界是：仅识别已固定 pnpm 生成的 importer 区块，保留其余全部字节，拒绝重复/缺失 importer 及超出这三个包的 workspace link，最后交给原 pnpm --frozen-lockfile 解析和验证。它不是通用 YAML 解析器，也不改原 Git 锁。

## stage 与运行期约束

候选把依赖目录放在同一个 mikka_release/worker-install 内，并通过 os.path.relpath 创建三个原包的 node_modules 链接。这样发布时原 mv -T 对整个 stage 重命名，不会留下绝对 .stage 路径。源码 build 仍从原 source 执行；esbuild 已是 daemon 的 devDependency。

此目录必须随 release 保留，不能在构建后删除。cloud bundle 仍 external Claude SDK 和 pino，后续 cli-finalize 也要沿原 daemon package 的 require.resolve 找到真实 SDK/native bytes。所有 realpath 继续位于同一个 release 内，才适用现有 --relocate-from/--relocate-to、chmod、原子发布和回滚逻辑。

作者还需提供实际 frozen install/原 build、真实 native SDK resolution，以及 stage rename 后同入口仍可加载的证据；本 reviewer 不重复它们。原 frozen 锁与 lifecycle 策略不能取消，不能通过 ignore-scripts 或删锁来获得绿灯。

相同的 lock_projection 指纹不表示整个 worker_hash 不变。新增 helper 和 bootstrap 修改都进入现有 WORKER_PATHS，最终 W 必须重新计算并走正常 CLI 守恒、真实订阅、发布/清理门槛。此分析没有新增正式样本或生产速度结论。
