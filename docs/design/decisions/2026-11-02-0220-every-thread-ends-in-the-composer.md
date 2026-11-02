# Every thread ends in the composer, finished or not

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session, on an Artifact window whose
  thread (已完成) showed no input box: 「这里怎么又没有这个对话框啊…你统一的查一遍」
- Rule: R-10 (states it for ended threads and every place a thread opens)
- Replaces: —

- Every place that shows a conversation ends in the shared composer
  (`ChatComposer`; the app's `Composer` on the phone):
  - bot chats and the Coordinator, group chats;
  - an open thread wherever it opens: the task page's right column, the
    thread column beside a chat, the Artifact window's side panel, a board
    card's task, the phone's thread page. They all draw `IssueThreadPanel`
    on the web, so the rule lives in one place.
- A thread that has ended (完成, 失败, 已停止) keeps its composer. A message to it
  runs the thread again in the same thread (R-81).
- Read-only on purpose: the legacy agent archive (`LegacyChatArchive`): old
  URLs may open its history, but it can never start another generation. A
  thread the viewer cannot read in full (someone else's) shows no composer,
  since it shows no conversation either.
- 现状（非决定）：the server still refuses a message to an ended thread
  (`runNotActive`); until it runs the thread again, sending there keeps the
  draft and says 「发送失败，草稿已保留」 (backend, open).
