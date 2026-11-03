# Attach files in every chat

- Date: 2026-11-03
- Source: Alex, in the attachment repair chat: 「很多都有麻烦，你全都加上可以吗？你就看其他竞品加了什么，你加什么，而且，像 Markdown 之类的肯定很重要的东西，麻烦你都要加上呀」; 「不只是BOT吧，还有Agent呀，凡是涉及聊天界面的，你都要处理吧」.
- Rule: R-10, R-42
- Replaces: —

Attachment support covers bot chats, group chats and Agent threads, on web,
desktop and mobile. Markdown, source code, images, PDF and Office documents
are part of the requested scope. Compare other common formats with the
official ChatGPT and Claude support lists; audio is included in the proposal
because ChatGPT supports audio uploads.

Dropping files, pasting files and choosing files with 「+」 must use the same
handling. Opening a file picker is insufficient: the recipient must receive
readable content. An Agent must receive its files, just as a bot does.

The existing shared composer's missing drag/drop and clipboard handlers are
repaired separately, without changing its appearance or existing text-file
contract. After the long-filename overflow was corrected, Alex approved the richer
attachment states: 「现在可以了，继续吧」. The following frames are **accepted**:

- Figma page: [`917:456`](https://www.figma.com/design/zPe5LKycb2XuT1ivCLRw07?node-id=917-456).
- Proposal and coverage: [`../chat-attachments.md`](../chat-attachments.md).
- New attachment UI follows the confirmation requirement in
  [`2026-11-01-0330-ui-figma-and-skill-review-before-code.md`](2026-11-01-0330-ui-figma-and-skill-review-before-code.md).
