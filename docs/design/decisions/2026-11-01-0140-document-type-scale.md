# Documents read at 15px under a 24px title

- Date: 2026-11-01
- Source: Alex, relayed by the coordinating session after the demo-data review: the task page and the Artifact reader had a heavy ~30px title over ~13px body (「标题和正文大小差太多」); follow Linear and Notion
- Rule: R-32 (adds the document steps)
- Replaces: the task title at 30px (`md:text-3xl`), document bodies at 13–14px with 28px leading, Artifact headings smaller than the title by one step only

Documents people read use four steps: 24/32 SemiBold title, 18/28 SemiBold
section heading, 15/24 Regular body, 12/16 meta. The 15px body is one theme
token, `text-md` (`app/globals.css`), the only `--text-*` value the UI policy
accepts, pinned in `ui-policy.json`. They apply to a task's title and
description, the Artifact reader and comments. Chat keeps 14/22, including
the thread pane beside a task or an Artifact.
