# 仓库、setup、变量、secrets 归 Environment，不叫 Project

2026-11-19。对齐 Capy 的 Captain / 自动化设置时，Alex 定下来的命名与分层。

## 背景

Capy 把仓库清单、dev environment、环境变量和 secrets 挂在「项目」上；Captain 和自动化选一个项目来跑。Mikka 已经有同样职责的东西：`workspace_environments`（`repositoryKeys`、`setup`、`variables`、`secretIds`，见 `lib/project-resources/contracts.ts`）。任务看板上的 Project 则是任务归属，是另一件事。

## 决定

- 运行要用的仓库、setup script、环境变量、secrets 统一叫 **Environment / 环境**，形态参考 Claude Code 的 cloud environment（Name、Setup script、Environment variables、secrets；默认环境不可改名、不可归档）。
- **暂不做网络访问限制。**
- Bot 绑定一个 Environment（`bots.environment_id`），`bots.repository` 下线并迁进 Environment。
- 自动化每次运行选一个 Environment（`definition.environmentId`，单选）。
- 任务记录的是这次实际检出的仓库和分支（运行时状态），不是配置。
- 任务看板的 Project（任务归属）不改名、不改语义。

## 怎么用

设计稿、缺口文档、后端字段里凡是「在哪个项目里跑 / 项目的仓库」一律写 Environment。不要再提议给 Bot 或自动化加 `project_id`。
