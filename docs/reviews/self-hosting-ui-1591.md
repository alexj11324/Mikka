# 自托管公共 UI 截图审查：PR #1591

## 版本与来源

- 源提交：`ffb90f209219a1c16060d70c715c638b58b2ae1b`。
- CI：[run 42328975860 / job 128270837860](https://github.com/alexj11324/Mikka/actions/runs/42328975860/job/128270837860)，构建、Expo 导出、截图和证据发布步骤均为 success。
- 固定证据提交：[`a9ed62cbd77cee6d00dd5674dbc5d496348f3143`](https://github.com/alexj11324/Mikka/tree/a9ed62cbd77cee6d00dd5674dbc5d496348f3143)。
- 原始清单：[evidence.json](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/evidence.json)；Web 构建清单：[build.json](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/build.json)。
- 37 张原 PNG 均从该固定提交下载，重新计算 Git blob SHA 与下载响应一致；PNG 格式和尺寸与清单一致。审查者逐张查看了原分辨率图片。
- 原始清单仍保留 `synthetic: true`、`reviewed: false`、`oauthAccepted: false`、`runtimeAccepted: false`；本文件单独记录审查，没有改写原始证据。

Web 图来自现有生产组件的独立构建组合，数据是合成 GET 记录；Expo 图来自真实生产导出。截图没有生产账号，没有完成 OAuth、服务器发现、登录、保存、计费或其他 POST。页面外围导航和真实服务状态不在本次证明范围。

## 实际看过的覆盖

| 界面 / 状态 | 主题、语言和宽度 | 张数 | 看图结论 |
| --- | --- | ---: | --- |
| 服务器未连接、已连接、读取失败、断开确认弹窗 | 中文，明 / 暗，1440 × 1000 | 8 | 表单和确认按钮未被截断；失败状态缺少重试，见问题 1 |
| 个人连接、个人授权撤销、撤销状态窄屏 | 中文，明 / 暗；1440 × 1000、390 × 844 | 6 | 个人已连接时显示个人额度；撤销时同时保留断开和重新连接；即使团队仍连接，也不显示团队额度可用 |
| 托管模型和充值入口 | 中文，明 / 暗，1440 × 1000 | 2 | 模型名称、Mikka 标识和充值按钮可读，没有截断 |
| GitHub App 未配置、已配置、错误、创建弹窗 | 中文，明 / 暗，1440 × 1000 | 8 | 图标、配置状态、授权仓库入口、错误及重试按钮可见；创建弹窗取消和创建动作分离 |
| GitHub App 组织创建弹窗 | 英文，明，1440 × 1000 | 1 | Owner、Organization name 完整；组织名为空时 Create GitHub App 禁用 |
| Expo 登录、服务器选择、自托管地址表单 | 中文，明 / 暗；375 × 812、430 × 932 | 12 | 标签、地址输入、连接和取消未溢出；暗色选中项难以辨认，见问题 2 |

这不是完整双语矩阵：英文云设置、英文手机页面、英文暗色和英文窄屏尚未截图。Loading、长服务器名、长 App slug、提交中的状态、键盘弹出、大字体、完整账户切换也未覆盖。

## 用户任务走查

表中的 Found 等结论只针对图中可见的任务入口；没有把独立组件图当作完整设置导航验收。

| 用户任务 | 修改前 | 本次处理后 |
| --- | --- | --- |
| 管理员首次连接服务器 | Found，服务器名称与连接按钮可见，严重度 0 | 沿用 |
| 管理员管理团队密钥、推送内容和连接 | Found，相关行与操作可见，严重度 0 | 沿用；保存、撤销和外部管理页仍需真实流程验收 |
| 管理员确认断开全部云连接 | Found，标题说明作用范围，取消在左、破坏性动作在右，严重度 0 | 沿用 |
| 用户从撤销的个人授权恢复 | Found，断开旧绑定和重新连接均可见；没有误显示团队额度，严重度 0 | 沿用；已有状态回归保持通过 |
| 用户从临时读取失败恢复云设置 | Missing，只有错误文字，无重试入口，严重度 2 | 新增复用现有 Button 的重试动作；只重读状态 |
| 用户查看托管模型并前往充值 | Found，模型与充值入口可见，严重度 0 | 同时补齐该区域读取失败时的重试 |
| 管理员创建组织 GitHub App | Found，归属和组织名字段可见，严重度 0 | 沿用；权限快照和真实 GitHub 授权不由本图证明 |
| 手机用户选择云或自托管服务器 | Present but insufficient，暗色选中态不可辨，严重度 2 | Web fallback 使用已有选中行颜色及次要标签颜色区分状态；待修复后 CI 图复核 |

## 问题 1：云设置读取失败后没有恢复入口

**出现率 4 / 10，影响 4 / 10。** 自托管部署首次配置或网络短暂失败时，`/api/cloud/status` 可返回 503。截图只显示“Mikka 云服务暂时不可用。”，没有重试按钮。源码的 `settingsReadOptions.shouldRetryOnError = false`，该错误分支也没有可触发重读的控件，用户只能离开或刷新页面。它是可复现的错误恢复缺失，不是字号或风格偏好。

证据：[明色错误图](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/synthetic-zh-CN-light-server-error.png)、[暗色错误图](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/synthetic-zh-CN-dark-server-error.png)。

最小修复在 `components/settings/cloud-settings.tsx`：服务器、个人与模型设置的读取错误均提供“重试”；使用既有 SettingsSection action 和 Button，沿用 Common.retry 文案。点击调用当前 SWR key 的 `mutate()`，请求仍在进行时按钮禁用，没有定时器或自动重试，也不提交连接 / 撤销操作。

## 问题 2：Expo Web 暗色服务器选项没有可辨认的选中态

**出现率 6 / 10，影响 2 / 10。** 两种手机宽度、云与自托管两种选中状态均出现。原图选中背景为 RGB(28, 28, 30)，未选中轨道为 RGB(28, 28, 31)，只有一个蓝色通道单位之差；两个标签也同色。用户在点击连接前看不清哪个服务器类别处于选中状态。

证据：[375px 云选中](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/synthetic-zh-CN-dark-mobile-375-server-choice.png)、[375px 自托管选中](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/synthetic-zh-CN-dark-mobile-375-self-hosted.png)、[430px 云选中](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/synthetic-zh-CN-dark-mobile-430-server-choice.png)、[430px 自托管选中](https://github.com/alexj11324/Mikka/blob/a9ed62cbd77cee6d00dd5674dbc5d496348f3143/synthetic-zh-CN-dark-mobile-430-self-hosted.png)。

最小修复在 `apps/mobile/components/Segmented.tsx`：暗色选中项改用已有 `colors.pressed`，未选中标签用已有 `colors.secondary`；不增加颜色字面量、不改变 token。保留 tab 语义及 aria-selected。iOS 使用独立 `Segmented.ios.tsx` 原生 Picker，本次未修改该文件；这些 Web 截图不能据此宣称原生 iOS 已验收。

## 清单结论与验证

- **复用：** CloudSettings / CloudModelSettings 继续使用既有 SettingsSection、SettingRow、Button、FieldError、Dialog；GitHub App 使用既有配置组件；手机使用已有 ServerSelection、Segmented、CardButton。没有新增组件、依赖或视觉体系。
- **外观：** 其余已覆盖状态未见文字截断、按钮重叠或白色暗色描边；GitHub App 行与托管模型行的品牌图标正常。弹窗无副标题，破坏性确认动作与取消分离。尚不包含 Figma 同尺寸对照。
- **文案：** 本次没有新增翻译键，重试复用中英已有 Common.retry；原有中文与唯一英文弹窗按图核对。
- **状态：** 撤销授权后仍有两种恢复操作，状态文案与合成记录一致；没有误声称团队额度立即可用。全量 Loading / pending / 原生键盘等状态仍不能勾选完成。
- **功能回归：** 新增三个读取恢复用例先在旧代码失败，修复后通过；覆盖服务器、个人、模型区域，只发一次状态 GET、无写请求，并保持撤销个人授权优先于团队绑定。
- **本地验证：** 云设置及相关模型 / 充值用例 14 / 14 通过；现有手机主题 token 检查 2 / 2 通过；涉及文件的 lint、TSX 转换及 diff 检查通过。
- **待补：** 本次修复后的截图尚未生成；需要在集成后的 exact head 上重跑既有 UI evidence job 并复核错误状态与暗色选服截图。没有运行本地浏览器，没有用旧图宣称新样式已经通过。
- **TestFlight 后续：** 检查两种服务器类别的原生选中态；地址键盘弹出后连接 / 取消可触达；真实 discovery 失败与恢复；账户切换及 Keychain 隔离；系统 OAuth 浏览器回跳；通知只打开对应服务器与账号。

## 本次修复的合并风险

**Merge risk: medium**

**Alignment: good ✅**
两项变更都对应固定提交的实际截图和当前源码中的具体原因，没有改桌面端或扩展云服务协议。

**Impact: small ✅**
只改变读取失败的恢复入口与非 iOS 分段控件的状态呈现；不改变授权、租户、计费、密钥或数据库结构。

**Verification: poor ⚠️**
修改前 37 图已实际审查，读取恢复回归通过；修改后的截图和原生 iOS 验收仍缺，必须保留该版本边界。

**Rollback cost: low ✅**
均为可回退的客户端改动，没有持久化状态迁移。

**Error detection: decent 👀**
单元回归能发现恢复入口消失；现有 CI 截图可揭示选中态回退，仍需要人工实际看图。
