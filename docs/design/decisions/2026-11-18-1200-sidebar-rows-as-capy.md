# 侧栏的 Bot 行和线程行画成 Capy 桌面版的样子

2026-11-18：Alex 看了生产环境侧栏的截图后说：「你改得跟 capy 一模一样！」「我让你去下载他们 electron，直接去看他们前端的源代码」，又问：「capy 上面有那些什么数字，什么 3 啊 2 啊 1 啊之类的，为什么你要加呢？」

参照的是 Capy 0.9.1 桌面安装包里渲染进程的源码（`shared/sidebar-threads.tsx` 的 `CaptainRow`、crew 线程行、`SectionHeading`、`CaptainOptionsMenu`）。这是对「付费组件原样使用」规则的一次明确例外：侧栏行的样子按 Capy，不按 App Shell 自带的行。

## 决定

- 侧栏有两种密度，默认「详细」，和 Capy 一样；在「Bot」标题的「···」里切换「紧凑 / 详细」，每个人自己的选择记在本机。
- Bot 行（含 Coordinator）：
  - 详细：两行，行高 52px，头像 32px。第一行是名字，名字后面紧跟展开箭头，右边是最后活动距今的简短时间（刚刚、5分、3小时、2天、1周）；第二行是最新一条消息的预览。没有消息时只有一行。
  - 紧凑：一行，行高 32px，头像 20px。
  - 未读只体现在名字上：有未读时名字加粗、颜色变深。**不显示未读条数。**
  - 行尾最多一个标记：这个 Bot 下有线程在等你处理时，显示一个实心小胶囊，里面是在等你的线程数（超过 99 显示 99+）；否则它正在回复时显示工作标记；都没有时显示时间。
  - 有线程的 Bot 才有展开箭头；收起时箭头在指针移到行上或键盘焦点进入时出现，展开后一直显示。
- Bot 下面的线程行：一行 32px，缩进到 Bot 名字下面（详细 42px，紧凑 30px），左边不放图标。标题，右边是在等你的小圆点或工作 / 等待标记，再是时间。指针移到行上时，时间换成「归档线程」按钮和「···」（打开这一行的右键菜单）。
- 「Bot」标题：点标题收起或展开整个列表，展开时箭头只在悬停时出现；右边「···」（密度）和「+」（新建 Bot）也在悬停时出现。「新建 Bot」不再作为列表最后一行。
- 已隐藏和已归档的 Bot 折叠在列表末尾，行用紧凑样式。
- 群聊（Capy 没有）沿用同一种行。

数据在公开仓库 `components/nav/bot-list.tsx`（`ChatNavEntry.preview`、`at`、`working`、`waitingCount`、`face`，`unreadCount` 去掉）和 `components/nav/compact-age.ts`；画法在私有 `mikka-hosted-ui` 的 `components/mikka/capy-sidebar.tsx`、`slots/app-frame.tsx` 和 `patches/app-shell.patch`（`ShellNavItem.row`、`ShellGroup.head`）。补充 [2026-11-17-2040](2026-11-17-2040-sidebar-row-menu-like-capy.md)。
