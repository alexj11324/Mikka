# A thread shows only its task; long messages fold

- Date: 2026-11-06
- Source: Alex, Mac desktop, about 15:40 UTC, on the thread 「测试派发流程：在 Mikka-handoff 新建测试文件」: 「我怎么感觉把 system instruction 也发进去了呢？……按照道理来说，只应该发中间的那段话才对，上下的 system instruction 为什么会一起发出来呢？不应该隐藏一下吗？」 and 「这么长的文字，难道不应该缩成一段折叠起来，显示 Show less / Show more 吗？」
- Rule: —
- Replaces: —

1. A thread's first bubble shows only the task the person or the Coordinator
   wrote: its title, its text and Notes for this run. Factory guidance, the
   repository check and standing instructions are still sent to the Agent
   unchanged but do not enter the conversation, as in Codex cloud and Devin.
   A muted 查看完整指令 link under the bubble shows the whole prompt on request.
   Which part is the task is recorded at dispatch (`agent_runs."promptTaskStart"`
   and `"promptTaskLength"`, code points), never guessed from the text; system
   text prepended later shifts the start. Older runs show their whole prompt.
2. A long message a person sent, or a thread's task, folds to its first lines
   with 显示更多 / 收起 (Show more / Show less) under it, as Claude.ai and
   ChatGPT do: on the web and desktop in every chat and thread
   (`CollapsibleMessage`), and on iOS with the native line limit (`FoldedWords`).
