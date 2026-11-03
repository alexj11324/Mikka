# 首次引导加一步「绑定订阅」

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator: onboarding 里要有「绑定订阅」入口（Claude、ChatGPT），直接复用「模型订阅」现有的连接组件和流程，行为不变，可以跳过
- Rule: R-40
- Amends: `docs/design/onboarding.md` §4（新增第 1b 步）

起名之后、云电脑之前，Bot 问「要绑定你的 Claude 或 ChatGPT 订阅吗？」，下面是设置 ›
模型订阅的连接行，同一个组件和同一套登录流程，只把卡片标题换成「绑定订阅」。绑定了显示「继续」，
没绑显示「暂不绑定」；部署没开订阅服务时这一步不出现。其余步骤不变。
