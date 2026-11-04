# Computer 实时状态：精确提交的本地构建与截图

对应 PR #1281 / issue #1212。产品 head `05ca8adad57a2687fa5f376ccb7551977a19af68`，tree `9179c070a7962532b2130d257a95d75bee523a92`。这份证据单独保存，未改变产品 head。

## 实际完成的检查

- Vercel Sandbox，8 vCPU / 16 GiB，Node 24.22.1、PostgreSQL 17、固定 pnpm 10.34.3。
- 从上述 head 正常执行仓库 `pnpm build`，包含 worker 构建、UI 生成、Next production build、类型检查和本地迁移；随后 `next start`。公开的本地 version 响应与 head 精确相等。
- 使用新建的隔离 loopback 数据库及专属数据库角色；TestAccountPool 正常注册/登录，保留环境 challenge/数据库身份校验，没有注入会话或绕过认证。
- 2026-11-04 **22:46:07–22:46:12 UTC** 拍摄 8 张 PNG。每张都有一条实际授权 Computer GET 200；控制台错误和 HTTP 失败均为 0。图片和 manifest 均通过 TestAccountPool 的凭证/会话证据审计。
- 捕获完成后移除显示夹具、释放并隔离账号对、停止本次 Next 进程，最终删除本次数据库和专属角色。清理日志及 pipeline 回执保留。
- 根代理已亲看全部 8 张图：两种语言、1440/390 宽度及明暗主题下，Computer 标签、休眠画面和 Wake/唤醒按钮无裁切或重叠；手机通过实际聊天标题按钮打开详情页。

独立审阅者也已亲看并核验全部 8 图的 SHA，结论见 [独立视觉复核](INDEPENDENT-05CA-VISUAL-REVIEW.md)。

## 截图

| 语言 / 尺寸 | 浅色 | 深色 |
| --- | --- | --- |
| 中文 / 1440×960 | [图片](computer-visual-1793832311_5caa/zh-sleeping-1440-light.png) | [图片](computer-visual-1793832311_5caa/zh-sleeping-1440-dark.png) |
| 中文 / 390×844 | [图片](computer-visual-1793832311_5caa/zh-sleeping-390-light.png) | [图片](computer-visual-1793832311_5caa/zh-sleeping-390-dark.png) |
| English（英文）/ 1440×960 | [图片](computer-visual-1793832311_5caa/en-sleeping-1440-light.png) | [图片](computer-visual-1793832311_5caa/en-sleeping-1440-dark.png) |
| English（英文）/ 390×844 | [图片](computer-visual-1793832311_5caa/en-sleeping-390-light.png) | [图片](computer-visual-1793832311_5caa/en-sleeping-390-dark.png) |

## 证据边界

显示夹具是一份明确标记的本地合成 E2B 配置，使用隔离进程内验证器供正常 UI 展示休眠电脑。没有真实 E2B key，没有启动任务机器，没有点击 Wake，没有发送模型请求。图片证明真实构建、认证、API 和布局；**不证明生产 WebSocket 健康、唤醒/控制操作、生产流量降低或三模型路径通过**。

新订阅/缓存逻辑另有真实 React/SWR 与 PostgreSQL 门禁。精确最终 tree 的 React 5/5、定向 29/29、严格 UI audit、typecheck、lint 均通过；前一产品代码相同的整合 tree 的 Computer PG 7/7、Live PG 32/32 和网关/真实 workerd 日志保存在 `gates/`。最后一次提交仅将两个测试 harness 移到现有 `scripts/` 位置，未改变产品代码或测试断言。GitHub 精确 head 的 33 个检查已结束：28 success、5 条件 skip；详见 `ci-checks.json`。

## 保留的失败

1. 第一版截图启动因没有数据库密码，被正常 bootstrap 的 `DATABASE_URL_INVALID` 拒绝。随后为本次独立数据库创建真实随机密码角色；没有放宽守卫。
2. 使用 `127.0.0.1` 时，NextRequest 实际把 origin 归一为 `localhost`，因此精确环境身份校验拒绝。实际 origin proof 与失败日志保留；最终把 bootstrap/build/start 统一为 `localhost`。
3. 第一次手机截图误用仅桌面显示的右栏按钮，已保留超时与两张截图的计数。按实际源码使用手机聊天标题按钮后，最终 8 张全部完成；没有修改 UI 来适应截图。
4. 初始 PR 的严格 UI audit 拒绝位于 hooks 中的测试 DOM 容器。最终只移动测试文件到现有 scripts 布局并修正导入路径，完整 assertions 保留；不是忽略审计。

原始图片包 SHA-256：`be9840f643061a2ac1c5f4638a7e8b76501d2e82a2871292bd7e8799414f6324`（215,441 bytes）；补充完整门禁包：`a484e7db64ee8a31eb16e17e3448b8758aa2bca09078a5911a05778fc877c8db`（21,216 bytes）。逐图片 SHA 见 manifest。

## 尚未完成

正文要求的固定真实任务一小时 before/after、三路径生产验证、同版本网关能力握手、合并后的 Web deploy 与公开生产 build 精确匹配仍未完成。PR 保持未合并，不以这些本地截图代替生产验收。

