# Issue #1415 完整结构化证据（历史索引）

原始完整证据没有被改写或重新判定。为避免已关闭任务的 1.57 MiB 原始 JSON 长期占用当前工作树，本页仅保留可恢复的档案入口：

- [原始完整证据（固定 Git commit）](https://github.com/aspectly-labs/Mikka/blob/ed905baee7482c43b29e8b15480ebbae160278c1/docs/acceptance/issue-1415/final-evidence.md)。清理前该 Markdown 为 **1,643,484 字节**，包含完整的 38,340 行历史报告与结构化 JSON。
- 原文记录的**输入 JSON SHA-256**：`374efec6e6f753104c2a491379e4b430fc486ac0df98b38c9b7f555772496964`。这是原输入 JSON 的校验值，**不是**本索引文件的哈希。
- [最终验收报告](final-report.md)与 [Issue #1415 的最终回执](https://github.com/aspectly-labs/Mikka/issues/1415) 保留状态、版本、成功与失败的含义。

需要在本地检查完整历史原文，可从仍然存在的 Git 历史恢复：

```sh
git show ed905baee7482c43b29e8b15480ebbae160278c1:docs/acceptance/issue-1415/final-evidence.md > /tmp/mikka-1415-final-evidence.md
```

此操作只减少当前 `main` 的检出体积，**不会缩小既有 Git 历史**；不得据此改写历史、force-push 或覆盖原验收结果。
