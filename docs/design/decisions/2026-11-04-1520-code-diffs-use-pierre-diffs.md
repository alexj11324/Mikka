# Code diffs on the web use Pierre's @pierre/diffs

- Date: 2026-11-04
- Source: Alex, GitHub issue #1226: "网页端显示代码改动的地方，改用 Pierre Computer 的开源库 `@pierre/diffs` … 直接用它原本的样子，不要按我们现在的样式重新调。"
- Rule: —
- Replaces: —

Every code diff on the web is drawn by `@pierre/diffs` (Apache-2.0, pinned to an exact version) with its own look and its default `pierre-light` / `pierre-dark` themes. Mikka does two things only: the light or dark theme follows Mikka's own mode, and the diff takes the full width of the area it sits in, not a narrow card. The old hand-written diff rows and their styles are gone.

That covers a suggested change in a chat (`BeFileDiff`, `components/agents/file-diff.tsx`) and a thread's 改动 tab (`components/workspace/thread-changes.tsx`). Lines are stacked (`unified`): a chat column and the side panel have no room for two sides. Hunks are separated by the library's plain `simple` separator, since its "N unmodified lines" text is English only. The library header carries Mikka's controls in its slots: 复制 in a chat, fold and 在新标签打开 in 改动.

Not in scope: Markdown document versions (`lib/artifacts/diff.ts`), the React Native diff on the phone (the library needs a browser DOM), and `@pierre/trees`, still beta.
