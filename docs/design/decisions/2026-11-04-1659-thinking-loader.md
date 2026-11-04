# The wait before a reply is affectUI's Thinking Loader

- Date: 2026-11-04
- Source: Alex, GitHub issue #1235: 「AI 思考中的状态改用 affectUI 的 Thinking Loader … 直接用它原本的样子，不要按我们现在的样式重新调。」
- Rule: —
- Replaces: the 「Coordinator 正在处理…」 shimmer line under the chat, and the live 「思考中」 shimmer in `ReplyActivity`

From the moment a message is sent until the reply's first word, the chat ends in affectUI's free Thinking Loader
(`components/ui/thinking-loader-clean.tsx`, MIT, installed unchanged from its shadcn registry item; no affectUI Pro
item is used). Its look is affectUI's own: the white pill with hairline shadows, the eight-ray blue spinner and the
sweeping label, dark under Mikka's `.dark` class, still under `prefers-reduced-motion`.

Its label follows the stream's real events (`components/coordinator/reply-wait.tsx`): 思考中 / Thinking after the
message is sent and while the model thinks, the running tool's own label (搜索网页, 查看任务 …) while a tool runs,
阅读结果 / Reading results once a tool returned and no word has come. On the first word it turns into a check with
思考了 N 秒 / Thought for N seconds, and after 0.7 s only the reply remains. A later step that runs a tool brings it
back. While the loader says 思考中, the reply's own 「思考了 N 秒」 line appears only once thinking ends, so the chat
never shows two thinking lines.
