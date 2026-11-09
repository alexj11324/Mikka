# 固定联合源码 canonical worker 计算

结论：joint8c 的原 hash-only 入口真实输出 `75b7462d53f9725cb92d40112c504b4f32d795c0`。这是离线源码指纹，不是已发布、构建成功或正式验收的证明。

| source | tree | W | selector leaves |
| --- | --- | --- | ---: |
| 8c423db291f8121980267cd48a24e428c992f618 | 195a66e213ca33c100e2900129079c5f83b06272 | 75b7462d53f9725cb92d40112c504b4f32d795c0 | 480 |
| 4c2efa6e9c57af88168c2d57039982ae29a9b54e | 00ce4e05bb696a492183f361e4ada67eb9627e30 | 330b07a15ab6b5b0670d798736062ec1d053694e | 479 |
| e189d7652fd2fce48b77a3697abf5bb177d8ebd1 | 74b7be77de23f66162ae9558c863bb2fc9b06a56 | 425451558243799262de400b4c55eff193a349c6 | 476 |

三份 scripts/e2b/build-template.py 都是同一 Git blob `1db4f39b19e83d49404f1df7fd78092d3f9b7ab3`，55730B；逐 source 原入口均 exit0。

## 算法与边界

原脚本255–275行读取 WORKER_PATHS 与 RECIPE_PATHS 的 immutable ls-tree；非 package/lock 项直接哈希整条 mode/type/blob/path；package 使用原 package_projection；lock 使用原 daemon importer closure projection。88–92行验证完整 source commit，889–891行在任何 E2B_API_KEY/构建操作之前返回。

临时目录中保存了各 source 的原字节脚本，使用私有 bare Git object store + 指向现有库的只读 alternate。凭据环境清空；GIT_NO_LAZY_FETCH=1、GIT_CONFIG_NOSYSTEM=1、GIT_CONFIG_GLOBAL=/dev/null、GIT_OPTIONAL_LOCKS=0。没有 clone/checkout/更新ref、安装、测试、构建、CI、DB、模型或云资源操作。仅3个缺失的固定公开 package/lock blob 通过 GitHub读取，并核 Git OID 后写入私有对象库。root checkout 保持clean。

第一次 hash 调用因缺8c的package blob失败，原stdout/stderr保留在 joint8c/initial-missing-object-hash.*；这不是源码hash失败。后续补齐3个公开blob后原命令真实成功。一次额外读取8c pnpm-workspace正文仍因本地缺blob拒绝；没有为它补取对象，因为原canonical算法只需其已核tree mode/blob。未将该失败推为产品缺陷。

## 4c → 8c 的精确端点差异

raw selector 6项变化，其中5项影响canonical输入：

- `packages/daemon/test/fakes/fake-claude-generation-abort.mjs`：内容blob不变09e075…，仅100644→100755；整条ls-tree进入hash，故影响W。
- `packages/daemon/test/fakes/fake-codex-generation-completion.mjs`：内容blob不变2b4fd7…，仅100644→100755；同样影响W。
- 新增 `patches/ffmpeg-static@5.3.0.patch`，blob5e27d8d12fbed2d0c2e62083976de11c86d9e1fa。
- `pnpm-workspace.yaml`：blobcc47ee1a48b9585e06c87e0f5ed6f14211601c0c→6d9e660acbcc3c800549c4a3502ef5b1433a6a4d。
- `pnpm-lock.yaml`：原lock_projection的实际差分只有 patchedDependencies 增加 ffmpeg-static@5.3.0 的3行（hash/path）。原投影全局保留该map，不因ffmpeg不属于daemon运行闭包就消失；diff原件已保存。

第6项 `package.json` raw blob虽变，但原ROOT_PACKAGE_KEYS只选packageManager/engines/pnpm，三 source 此有效投影逐字相同，因此不改变W。不能把raw root package变化直接记成worker变化。

## e189 → 8c 的精确端点差异

raw13/effective12；root package projection仍相同。12项为：official-e2b-instance-bootstrap.sh；新增prepare-worker-install.py与其test；codex-protocol.ts、codex.ts、新增codex-item-chunks.test.ts；ffmpeg patch、pnpm-workspace、lock projection；official-files.py、e2b-finalization-files.json、e2b-certificate-relinks.json。每项前后mode/blob在report.json内。

这不是三点merge-base差分。e189的其余主线变化并不由本计算外推兼容或忽略；最终合流、构建、发布和正式六例须绑定其实际source。三份W互不相同，不能复用旧W作为联合源发布身份。
