# Issue #1415：开发冷启动与 React 热更新验收

本驱动只比较两个固定开发版本：旧 Next dev 与新 Vite + Nitro dev。它不构建镜像、不安装依赖、不迁移数据库、不部署、不获取账号，也不管理云虚拟机。当前交付仅为可审阅脚本；没有实际性能结果。

## 测量定义

两侧各完成三轮，顺序为 Next 1 → Vite 1 → Next 2 → Vite 2 → Next 3 → Vite 3。任一轮失败即保留该次报告、日志、失败截图，精确清理后终止，不自动重试或把失败排除后计算中位数。

每轮启动一个新应用进程和一个新 Chromium 上下文。Chromium 本体预先启动，因此应用冷启动不包含浏览器安装或浏览器启动时间。冷启动计时从 `spawn` 前开始，到真实登录标题出现、两个输入可编辑、现有 React 点击处理器成功把焦点送到 email，再实际输入和清空两项内容为止。没有提交表单。SSR 可能先于 React 事件绑定出现，因此 addon→focus 使用每动画帧一次的无业务副作用 DOM 点击探测；首次真实处理成功即停，并保存尝试次数/时刻，避免单次过早点击丢失被误判失败。没有服务端轮询。

访问路径是 **`/mikka/sign-in?login=1`**。旧 Next 开发模式访问裸 `/mikka/sign-in` 会转去 `/api/acceptance` 并创建验收身份；`login=1` 是产品已有的正常登录入口参数，避免测到自动账号流程。两侧使用相同路径、中文、UTC、1440×900、DPR 1。

清空的只有专用快照内、未跟踪且被 Git 忽略的编译缓存：Next 的 `.next`，以及 Vite/Nitro 的 `.cache/dev-runtime/<port>` 与 `apps/frontend/node_modules/.vite`。不清操作系统页缓存，不把它称为磁盘冷缓存；依赖已经安装。数据库、共享服务均保持现有状态。

热更新只修改两版本中 SHA256 完全一致的现有文件：

`components/blocks/auth-19/components/auth.tsx`

它在登录页已经渲染的 `<main>` 上增加一次唯一 `data-mikka-perf-hmr` 属性，不改逻辑、样式、身份或网络行为。从写文件前开始计时，直到浏览器 DOM 实际出现该值。浏览器在每份新 document 建立一个随机标识，前后标识和主 frame 导航计数分别记录，明确报告是否整页重载。测量完成并不代表“没有重载”或“更快”；结论必须看这些字段。

RSS 是 Linux `/proc` 中本次独立进程组内全部应用进程之和，每 250 ms 采样；报告明确使用 **sampled peak**，不冒充内核精确峰值。浏览器内存和已有数据库进程不计入应用 RSS。报告保存全部 RSS 采样、实际 Node/框架/浏览器版本、固定 revision、命令、源码哈希、HTTP 返回值、原始耗时及清理结果。只有完整六轮通过时才产生两侧中位数，没有自动性能阈值。

## 必要环境

- 由 root 协调资源并在同一台空闲的 Linux 验收机顺序运行。不要与构建、冷启动或其他性能采样并发。此处的 root 指协调 agent；**OS 执行用户必须是普通非 root 用户**。
- 提前建立两个独立、干净、detached HEAD 的快照，放在单独的 `snapshotsRoot` 下。实际 source revision 必须与配置完全相同。禁止使用主 checkout、dirty tree、源码 hardlink 或把缓存指向其他 checkout 的依赖 symlink。
- 快照和待改文件归执行用户所有。允许正常 pnpm 依赖链接，但 `.vite` 的实际可写父目录必须仍位于该快照内。可使用普通独立安装；不要把整份 frontend `node_modules` 链接到主 checkout 后运行缓存清理。
- 根目录不能留任何 Next 会自动读取的 `.env*` 文件。已有真实隔离环境的变量由父进程在内存中传入，配置只列变量名。必须有真实 `BETTER_AUTH_SECRET`、本地 PostgreSQL 的 `DATABASE_URL` 或 `MIKKA_DATABASE_URL`，数据库名称以 `_e2e` 结尾。没有凭证字面值写入配置或报告。
- 相同 auth/feature 配置应用于两侧；若真实配置关闭 email 表单，测试应失败，不能改 flags 或伪造 UI 让它通过。保留已有环境需要的公开配置变量名。不得传 `NODE_OPTIONS` 注入器。
- 同一明确 Node 二进制、已安装的 Playwright 和 Chromium。脚本使用 `chromiumSandbox: true`，不接受 `--no-sandbox` 或沙箱降级。用户 namespace / seccomp 环境需正常支持 Chromium。
- 两个不同、空闲的 loopback 端口。脚本不接管已有监听器，只启动和停止自己的子进程组。
- 输出目录必须尚不存在，其父目录预先存在且可写；目录和报告分别使用 0700/0600。日志会遮盖所转交环境变量的值；仍应按私有诊断材料保存，不直接发布整份原始日志。

## 显式配置

下面是结构示例。所有 `<...>` 必须用真实固定值替换；版本从对应快照的已安装 package manifests 获取，不根据 lockfile 猜测。`protectedRoots` 至少列实际主 checkout，其他生产/开发 checkout 一并列入。

```json
{
  "snapshotsRoot": "/work/mikka-runtime-perf/snapshots",
  "protectedRoots": ["/work/Mikka"],
  "output": "/work/mikka-runtime-perf/evidence/run-<unique-id>",
  "nodeVersion": "v24.22.1",
  "envNames": ["BETTER_AUTH_SECRET", "MIKKA_DATABASE_URL", "DATABASE_URL", "VERCEL_ENV"],
  "browser": {
    "packageRoot": "/work/mikka-runtime-perf/snapshots/vite",
    "playwrightVersion": "<actual-installed-version>",
    "executablePath": "/opt/mikka-playwright/<actual-chromium>/chrome-linux/chrome",
    "chromiumVersion": "<actual-browser-version>"
  },
  "targets": [
    {
      "kind": "next",
      "root": "/work/mikka-runtime-perf/snapshots/next",
      "revision": "<40-lowercase-hex-next-revision>",
      "origin": "http://localhost:3110",
      "command": ["/usr/bin/node", "node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "localhost", "--port", "3110"],
      "cachePaths": [".next"],
      "versions": {"react": "<actual>", "react-dom": "<actual>", "next": "<actual>"}
    },
    {
      "kind": "vite",
      "root": "/work/mikka-runtime-perf/snapshots/vite",
      "revision": "<40-lowercase-hex-vite-revision>",
      "origin": "http://localhost:3111",
      "command": ["/usr/bin/node", "apps/api/scripts/dev.mjs", "--host", "localhost", "--port", "3111"],
      "cachePaths": [".cache/dev-runtime/3111", "apps/frontend/node_modules/.vite"],
      "versions": {"react": "<actual>", "react-dom": "<actual>", "vite": "<actual>", "nitro": "<actual>", "@vitejs/plugin-react": "<actual>"}
    }
  ]
}
```

允许只读预检：

```sh
/usr/bin/node /absolute/ops/runtime-performance.mjs --config /private/runtime-performance.json --check
```

预检只检查路径、Git、版本与权限前提，不修改源码/缓存，不启动应用或浏览器，不访问数据库。实际执行去掉 `--check`，由协调者在上述条件满足后启动；本交付未执行该命令。

## 结果与清理

`report.json` 在每次状态变化后落盘。每轮独立保留 `<kind>-<iteration>.log`；失败时保存对应 PNG。不要覆盖已存在的输出目录或改写失败报告。修改实现/环境后另开新编号，保留前次实际失败。

每轮 finally 只在当前源码仍等于原文或本次确切补丁时恢复原始 bytes，并核验 SHA256 与 Git clean；若发现外部改动，保留它并报错，禁止覆盖。随后关闭本次 browser context，向本次 detached 子进程组发送 SIGTERM，最多等 30 秒；必要时 SIGKILL 只针对同一组且视为清理异常。主进程结束时只关闭自己启动的 Chromium。脚本不停止已有数据库、应用、daemon 或 VM。

浏览器所有非本地同源 HTTP/WebSocket 请求在发送前阻断，没有伪造应用响应。这一限制在两侧一致；报告记录阻断 origin。测量本地开发交互，不把第三方分析或 OAuth 服务的网络时延混入结论。
