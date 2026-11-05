# #1415 验收证据

本目录保存可核对版本、环境和范围的实际结果。当前是进行中的证据记录；单元测试、数据库测试或 Linux 诊断通过，不等于 Apple Silicon 打包验收完成。

## 已完成的局部验证

| 证据 | 运行版本与范围 | 实际结果 |
| --- | --- | --- |
| [会话缓存数据库回归](desktop-session-cache-db-9fa8be5d.json) | `9fa8be5d` 加文件中列明 SHA-256 的源增量；独立 checkout、真实 PostgreSQL；包含鉴权 SQL | 23 通过、0 失败、0 跳过。`preferences.getPreferences`：web 与修正后 native 都是 2 条 SQL、635 B；原 native 为 4 条 SQL、1,694 B。 |
| [工作区旧链接与公开 Artifact](desktop-links-db-154a6efa.json) | `154a6efa` 加记录中的测试连接绑定修正；实际原始 reader、权限和数据库 | 6 通过、0 失败、0 跳过。旧 slug 两端 250 B；公开 Artifact 两端 956 B。 |
| [有界审批元数据读取](rpc-db-8e81c003.json) | `8e81c003`；真实数据库和 HTTP 边界；身份 fixture 的模拟范围已单独注明 | 16 通过、0 失败、0 跳过。完整文档 1,200,377 B，所需元数据投影 283 B。 |
| [原 Next 构建测量](baseline-build-a1b633178.json) | main `a1b633178`；Large 8 CPU / 16 GiB；`/usr/bin/time -v` | 245.21 秒，峰值 RSS 11,168,596 KiB，退出码 0。不是第二阶段最终对照版本。 |

字节值是已预热 PostgreSQL 连接的 socket `bytesRead` 差值，范围以各 JSON 为准。上述每次读取的比较不能替代完整一小时空闲测量，也不能推广为所有路由已经验收。

会话缓存复用 Better Auth 原有签名、版本、到期和 bearer 绑定规则；没有额外 TTL。证明只保存在原生主进程的加密账户记录中，刷新由正常请求带回。数据库回归包含跨账号、伪造、到期、撤销、敏感操作重新查库、REST 续签、资料更新、一次性 PKCE 和鉴权审计失败。下一次发布后的 CI 与原生运行结果仍须绑定实际提交。

## 原生诊断状态

`9fa8be5d` 的真实 Linux Electron 已验证未登录窗口使用本地 `mikka://app`、renderer 无 Node、CSP 阻断外部 fetch。另一个独立的启动器诊断实际完成了 `gnome_libsecret` 加解密，且 Chromium sandbox 开启；它使用 `9fa8be5d` 启动器和此前的应用构建，不代表最终 App 已完整验收。登录交接诊断发现 Playwright 的 `waitForFunction` 在此版本会把返回的 Promise 当作已满足条件；测试须在 Node 端等待真实会话值，修正后重跑。此处不计为登录通过、登录后的凭证隔离通过或 macOS 通过。

环境启动器的失败记录也已定位：编译时的版本必须与 checkout 一致，Next 请求规范化后的 `localhost` 必须与环境登记 origin 一致。所有改动保持原来的版本、数据库身份和租赁校验；原本绑定其他 origin 的数据库没有重新绑定或被接管。

## 尚待实际通过的第一阶段清单

- [ ] 所有指定页面，浅色/深色，同尺寸逐像素差异不超过 0.1%，附原图和差异图。
- [ ] Apple Silicon 打包 App 的通知、角标、更新、半透明窗口、深链接和其他原生能力。
- [ ] 真实断网启动和恢复联网。
- [ ] 成对测量的冷启动到可操作时间优于原网页壳。
- [ ] 真实一小时空闲数据库查询/字节不高于网页版；不排除实际本机 daemon 产生的后端流量。
- [ ] 凭证隔离、系统浏览器登录、IPC、CSP 和导航边界；外部 provider 回跳与应用内 PKCE 交接分别记录。
- [ ] 同一 main 基线的网页迁移前后截图一致，全部网页测试通过。
- [ ] 最终提交的全部 CI 通过，提供连隔离 HTTPS 后端的 unsigned Mikka Dev Apple Silicon ZIP。

第二阶段按 [Alex 的追加要求](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6664526271)，在上述第一阶段完成后继续。目前只有[兼容性研究](../../operations/issue-1415-phase2-feasibility.md)，没有将研究当成迁移实现或验收结果。生产设置、正式签名、发布和生产切换均未执行。
