# 分开部署的服务保留旧调用方兼容

- Date: 2026-11-20
- Source: Alex, [#2896](https://github.com/alexj11324/Mikka/issues/2896) and deployment epic [#2897](https://github.com/alexj11324/Mikka/issues/2897).
- Status: accepted compatibility rule; implementation and release evidence are tracked on #2896 and #2897.
- Reference: the three-stage rollout in [vespin's “Breaking the hosted wire”](https://github.com/ReviewStage/vespin/blob/main/AGENTS.md). Mikka reuses its own protocol and clients.

## 为什么

服务合并后可以独立部署，桌面、iOS、CLI 和 daemon 却按各自节奏发版。
移除旧字段的服务可能遇到几周前安装的客户端，也可能遇到尚未换镜像的
另一服务。发布顺序必须留出兼容窗口；一次整体切换不能代替这个保证。

## 客户端三步

1. 先发布同时读新旧格式的客户端代码，发送下一个 `HOSTED_API_VERSION`。
   此时服务仍提供旧格式；字段改名同时保留两个 key。
2. 桌面、iOS、CLI、daemon 都从该兼容提交或其后代发版，在发布记录中写明
   每端版本和不可变源码 SHA。源码已合并、构建成功或只发布一端都不算完成。
3. 后续 PR 才能移除旧格式并提高 `HOSTED_API_FLOOR`。低于下限的客户端在
   进入业务 handler 前收到 HTTP 426，保留明确 cause 并显示既有升级提示。

公共常量和解析器放在现有 `packages/protocol/src/version.ts`，请求使用
`x-mikka-api-version`。整数表示客户端能读取的 hosted API 代际，不替代
应用 semver、商店 build、Desktop RPC envelope 或 daemon device-session
协议。iOS OTA 可以更新 reader 而不改变 native build，因此不能只比较
商店版本。新版本只在 reader 真的兼容新格式时递增。

首次接入的 version 为 **1**，floor 为 **0**。已有客户端还没有该 header，
按 0 接受，服务继续提供全部旧格式。提高 floor 的提交必须附上第二步的
四端发版证据。本次接入不声称这些客户端已经全部分发到用户设备。

现有客户端标识（应用版本、desktop/mobile/daemon/cli kind、旧 mobile
telemetry）用于识别已安装客户端，不能作为认证或授权。普通网页和未声明
版本的 API 集成保留既有接口契约。一个显式但格式错误的版本被拒绝，不能
通过无效值绕过检查。等于或高于 floor 的 reader 可继续调用。

响应沿用 `update_required`，并增加 `minApiVersion` 和白名单 cause：
`api_version_missing`、`api_version_invalid`、`api_version_below_floor`，只含
声明版本和最低版本。Desktop 进入已有 `update-required` 状态；iOS 进入
已有「请更新到最新版」屏幕；CLI 给出安装更新命令；daemon 保留未完成
运行的输出和回执并停止不兼容操作。`GET /api/version` 始终可读并公布
`apiVersion` / `minApiVersion`，便于发现升级要求。

## 服务间先兼容，后删除

API ↔ Eve ↔ Task ↔ World 的请求和响应同样先接受新旧形态。所有受影响
调用方部署完毕后，再单独删除旧格式；同时验证保留的回退版本仍能工作。
公开代码中的私有 service binding、签名和租户校验继续使用原有实现，
兼容版本不扩大权限。

Web 和 API 可以使用不同的源码 SHA。`prepareRelease` 只固定 Web 制品的
`sourceSha` / `overlaySha`，API 的服务身份继续由受控 Service Binding
限定。该 API 可以原地更新，因此 Web 的 `/api/version` 每次从该 binding
读取后台版本，不缓存 API 源码或把它固定在 Web 环境变量中。它严格校验
公开字段、40 位源码 SHA 和协议代际，以 `build` / `overlaySha` 表示 Web
制品，以新增 `apiBuild` / `apiOverlaySha` 报告后台实际来源。现有网页
刷新器比较 Web build，不会因只换 API 而反复要求刷新。私有发布器用已
认证的 manifest 和部署后读回，分别核对真实 Web/API 的精确 SHA、digest
及绑定身份；不能仅凭版本端点返回合法 SHA 就宣称发布了正确代码。

已发布的旧 Web 严格要求版本文档只有五个字段。原始 API 只在请求携带
`x-mikka-api-version` 且 reader 版本至少为 1 时增加 `apiVersion` /
`minApiVersion`，无 header 仍返回原五字段。新 Web 发送自己的编译协议
header，不转发来访者的 Cookie、Authorization 或版本声明；接入期同时
接受旧五字段和新的完整字段对，未知字段、非法 SHA 和不完整代际仍拒绝。
这使旧 Web → 新 API、新 Web → 旧 API 和 API 独立更新/回退都保留可读性。

移动端主分支 OTA 也受同一私有部署策略控制。提交合并后仍执行类型检查，
但不会直接读取生产 Expo 凭据。工作流固定私有 main 的一个提交，复用其
只读 eligibility 入口核实 owner 窗口、已合并的兼容改造和真实预发回执；
通过后只取该回执指定的 UI overlay，并在发布前再次核对授权。默认关闭
或证据不完整时明确记录「未发布 OTA」，不把检查成功写成生产发布成功。
自动预发结束事件触发下一次检查，新 main 提交不取消已经开始的 OTA。

自动 OTA 还须确认移动端输入确实变动：比较上一次真实发布的 `apps/mobile`、
`packages/protocol` 和私有 mobile 目录的 Git tree 标识，不能只比较当前
提交与父提交。这样早先 mobile 合并等待预发时，即使被后续 Web 合并覆盖，
累积的未发布 mobile 变化仍会被保留；纯 Web 变化不会额外触发 OTA。

`mobile-production-ota-source` 是发布前上传的不可变输入回执，只包含源码、
tree 和原始 run/attempt 标识，不声明已经发布。消费者复用既有的有界 ZIP
读取与 SHA-256 核验，再检查原始 attempt 后续 `Publish to production`
步骤真实成功，且输入选择、授权复核和回执上传均完成。整个 workflow 绿色
不能代替该步骤的发布结果；发布后的清理失败也不能抹掉已经完成的更新。
回执先于 Expo 凭据读取和发布保存，避免发布成功后才上传回执失败而丢失来源。

仅考虑最新的受信输入回执。其发布失败、取消、跳过或回执过期时，自动路径
明确不发布，不从更旧成功运行借用基线。首次没有可核实基线也不自动发布：
由 owner 在已有窗口内以既有手动入口提供完整预发证据建立首份基线，恢复
也走相同策略。回执保留 90 天；需要恢复时新建手动 run，不能通过 rerun
覆盖已上传的不可变回执。格式、来源或原始 attempt 不匹配时直接失败，
手动入口不豁免这些检查。本次改造没有调用 Expo 生产发布，也未验证真实
设备安装、TestFlight 或正式移动端升级屏幕截图。

首个固定契约是 Node 调用方 → World Worker 的运行事件和读取 RPC。
`packages/eve-cloudflare-world/test/node-world.test.mjs` 使用上一成功 serving
源码 `64a3a8df554f7efdd00784a3790a544109ade658` 的真实客户端模块调用当前
Worker，覆盖创建、启动、完整读取及 metadata-only 读取。fixture 同时保存
源码 Git blob 哈希；来源是公开 [run 44473639414 的成功 serving job](https://github.com/alexj11324/Mikka/actions/runs/44473639414/job/135389683331)。
这是历史发布和本地契约证据，不是对当前生产 serving 的在线探测。
更新 fixture 需要新的成功发布回执；不能复制新实现来消除兼容失败。

原始模块以 `.mjs.txt` 文本归档在 `docs/release-fixtures/`，保留发布时的全部
字节；`release.json` 中的原始路径和 Git blob 标识也保持不变。不能把它们
当成当前产品源码或修改其中的历史实现。契约测试先逐份重算并核对 blob
标识，再在独立临时目录恢复原模块路径，使用现有测试 SDK
依赖执行旧调用方。因此当前源码的框架和部署策略扫描保持原有范围与断言，
历史协议兼容性也继续由真实执行验证；文档目录不是免测入口。

## 数据库 expand / contract

先加表/列并保留旧 reader 和 writer，完成双写、回填和全部代码切换后，
再通过另一个后续迁移删除旧列。执行过的迁移不改名、不改内容。

迁移检查拒绝相对 main 新增 SQL 中的 `ALTER TABLE … DROP COLUMN`，
包括省略 `COLUMN`、`IF EXISTS`、多 action 和静态 `DO` 块中的写法。
普通注释、字符串和 `DROP CONSTRAINT` 不会被当成删列。
确实完成切换的 contract 迁移必须在文件头写明：

```sql
-- migrate: contract #2896 reader cutover: <release>; backfill: <receipt>; rollback: <compatible release>
ALTER TABLE example DROP COLUMN old_value;
```

这里的 issue 和证据由评审验证。检查器要求显式标记，不自行断言切换已经
完成；动态 SQL、删表或其他破坏性操作仍须按迁移评审规则检查。没有 main
基线时保持现有警告行为，受信 CI 必须提供 main 历史。回退使用保留的
兼容代码和制品，不能用逆向 schema 操作假装恢复已删除数据。

## 验证边界

版本测试证明低于下限的拒绝及等于/高于下限的通过；API handler 测试证明
拒绝发生在写入前。四端传输测试覆盖实际发出的 header 和既有升级处理。
World 测试使用本地 Worker/Durable Object 运行时；迁移测试只操作临时
仓库和 SQL fixture。它们不调用真实模型、不创建 Neon 分支，也不证明
真实客户端发版、预发发布或生产自动晋级已经完成。这些发布结果仍以
#2897 的不可变 run、manifest 和发布 owner 窗口记录为准。
