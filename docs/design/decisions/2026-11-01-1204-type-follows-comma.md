# Type follows Comma

- Date: 2026-11-01
- Source: Alex, after Chinese looked wrong on the web app next to Notion: 「去查查comma的做法,我们的字体规则和他们的百分之百对齐」; the sizes too, relayed by the coordinating session the same day (xs 12/18, xl 20/30, -0.01em on lg and xl, chat 13)
- Rule: R-32
- Replaces: Geist with a named Chinese fallback (`"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"`), weight 400; Tailwind's default size tokens; chat at 14/22 from `2026-11-01-0140-document-type-scale`

Font rules match app.comma.surf as served on 2026-11-01:

- Text: Inter Variable (roman and italic, rsms/inter 4.1), then `"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif`.
- Code: Geist Mono, then `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`.
- No Chinese font is named. Chinese takes the system font for the reader's language (PingFang SC on a Mac with Simplified Chinese).
- Regular weight 450; `font-synthesis: none`; `text-rendering: optimizeLegibility`; `-webkit-font-smoothing: antialiased`.
- Fonts are held until loaded (`font-display: block`) with no metric-adjusted fallback face.

- Sizes: `text-xs` 12/18, `text-sm` 13/20, `text-md` 15/24, `text-lg` 18/28 at -0.01em, `text-xl` 20/30 at -0.01em, `text-2xl` 24/32. Chat messages are 13 on a 21px line, as Comma's message text (`text-sm` plus 8px).

Earlier rule, from 2026-11-01-0140 (now removed): documents (a task's title and description, the Artifact reader, comments) used a 24/32 title, 18/28 headings, a 15/24 body and 12/16 meta, with chat at 14/22. This decision keeps those document steps and moves chat to 13/21 and meta to 12/18 to match Comma.
