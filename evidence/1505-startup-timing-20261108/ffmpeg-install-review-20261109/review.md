# ffmpeg-static 5.3.0：原地重试不能保证 LICENSE 完整

固定本方源：02401458a7fe26e00ce4caa653084c7f9680696d，tree0013159d8dd0e1155b84d81907f19f4e1283cff7。触发事实由 root 唯一日志读取提供：E2B42566225093/2 的 desktop 在2026-11-09T05:41:25Z下载 linux-x64.LICENSE 得 HTTP504；本审查没有再次下载日志。

## 结论

不能把原地重跑原 pnpm install 或单独 pnpm rebuild ffmpeg-static 的零退出，当成完整安装证明。官方5.3.0脚本38–42行只要 binaryPath 是普通文件就直接 exit0；187–188行的 LICENSE 下载发生在 binary、chmod、README 之后。LICENSE504使本次exit1，却不清理binary，下一次hook会提前退出。该条件是明确源码行为，不是已对本次runner执行过的复现。

实际官方npm tarball 17329B，SHA2560525c908c27618582a6fb5d4cc70452a2f2d4f50cb3d88b19b16a3c1cc8df25d。npm SRI/SHA1均核同，SRI也匹配本方pnpm-lock。tarball install.js与upstream24504b7d549c0400e099720b3d5854577693a63a逐字相同；6186B/SHA9801ce3aa35e45f72f7d13339ff04c916011b529040d1a1301c74102ed335fb9。

## pnpm10.34.3不会替包补这个保证

官方signed tag指向c7c97c30dfa0640063e79362dbd5663ae9cc1b66；source-index.json保留每个源码的路径、blob、bytes、SHA与URL。

- build-modules先await lifecycle，失败的必需依赖直接throw；失败当次不会走后面的成功side-effects上传，也没有清理包生成文件。
- create-cafs-store的待构建包走clone-or-copy。indexed-pkg-importer对store来源、非force且package.json仍存在的目录可以跳过重新导入。它不检查生成的LICENSE。
- 即使下一次生命周期重新执行，上游binary-only guard仍会直接退出。rebuild也调用同一hook。
- 已缓存success side-effects是否被使用是另一分支，不能从单次exit0推出所有安装文件齐全。pnpm registry fetchRetries也不是这个第三方postinstall HTTP客户端的重试保证。
- 上游对README/LICENSE的404只警告，这也是必须显式检查完整性、不能只检查命令exit0的原因。

## 最小可接受的重试边界

若实际必须安装此包，有限重试须同时满足：原版本/lock/SRI/官方端点与scripts不变；每次重试使用本构建私有的干净package状态，或精确清除这个包的三个下载产物并强制其hook；不清共享store/其他release；不从未验证的side-effects恢复残缺成功状态；成功后核同包binary、README、platform LICENSE均为非空普通文件，并保留包自身许可证。后续原install任务仍须完整成功，单修一个包不替代完整install。总超时和次数必须有界。

本轮没有实现或验证该重试方案。只增加原install循环，或只执行rebuild，不满足上述保证。

若另一个review证明正式worker只需要daemon闭包而root的ffmpeg不属于它，优先纠正该安装集合；这样不用引入恢复残缺FFmpeg的额外机制，也没有跳脚本或换镜像。该闭包证明由template_prebuild负责，本报告不代其判通过。

## 范围

0安装/测试/postinstall/rebuild/vendor执行，0模型/SQL/生产查询/refs；没有下载FFmpeg二进制、README或platform LICENSE。只读取公开源与自己的ops文件，Git产品和正式脚本不改。不宣称成功率、节约毫秒、模板ready或正式达标。
