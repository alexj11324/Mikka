# Desktop 直接安装的凭据范围：不可变证据

本包对应纯修正提交 [8852021fa5cdb3361b6dda09df6243d9e320d369](https://github.com/alexj11324/Mikka/commit/8852021fa5cdb3361b6dda09df6243d9e320d369) 与组合提交 [bf4833c9010e7adff6dded6c348824d5e99554c0](https://github.com/alexj11324/Mikka/commit/bf4833c9010e7adff6dded6c348824d5e99554c0)。只包含审查材料和本地合成测试证据，不作为产品提交的父节点。

## 改动与验证

仅为 desktop.yml 的 checks、smoke、native-arm64 三个既有直接 pnpm 安装步骤显式传入现有 GitHub API 只读 token；原 permissions、条件、Electron skip 和写权限/发布入口保持原样。测试仅提取已有真实 lifecycle helper，并增加 Native 进程传入和三个入口绑定检查。

- RED：2 tests，0 pass / 2 fail / 0 skip，exit 1。原 Native 步骤的真实 postinstall 得到 token presence=false。
- GREEN：原 22 项 + 新 2 项 = 24/24 pass，0 skip，exit 0。修正后的 Native presence=true。
- Lint 与两文件增量 tree diff --check：exit 0。
- 本地进程测试使用固定 pnpm10.34.3、零依赖临时包和正常 frozen install；只记录虚构 token 的存在布尔值。没有生产请求、真实凭据、数据库、模型或新增资产下载。
- 本次整理没有重跑测试。远端 CI 42601454393/1 由发布者报告为 in_progress，synthetic commit 为 d56efbd5e76455a7991234d4b763c4acf8fa3025；本包不声称该 CI 已通过。

## 原件与来源边界

[source-review.json](source-review.json)、[independent-review.json](independent-review.json)、[changes.patch](changes.patch)、[red.log](red.log)、[green.log](green.log) 均为原字节复制，hash 保持不变。命令和结果见 [execution-receipts.json](execution-receipts.json)，摘要与文件 hash 见 [index.json](index.json)。不包含原 CI 日志或私有 API 响应。

RED runner 没有在执行当时采集输入 hash。其输入绑定依据保留的原 workflow、RED 前的精确测试写入序列，以及随后保持不变的测试文件重建；不得把它表述为 contemporaneous 输入快照。GREEN 的源码前后 hash 已实际采集且一致。

[此前 pure30e 凭据范围证据（固定 commit）](https://github.com/alexj11324/Mikka/blob/07381085c27941b206f28343aeaeffb9e5e6ff6f/docs/operations/evidence/1506-credential-scope-20261109/index.json) 保持独立，未改写此前仅覆盖 18 个共享 action 调用点的边界。Desktop 的三个直接入口是此次补齐。

未来 P0 Native helper 预备补丁没有在这两个产品提交中应用；本包也不声称 Electron/浏览器或生产验收已完成。
