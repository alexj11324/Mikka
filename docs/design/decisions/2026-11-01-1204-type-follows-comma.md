# Type follows Comma

- Date: 2026-11-01
- Source: Alex, after Chinese looked wrong on the web app next to Notion: 「去查查comma的做法,我们的字体规则和他们的百分之百对齐」
- Rule: R-32
- Replaces: Geist with a named Chinese fallback (`"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"`), weight 400

Font rules match app.comma.surf as served on 2026-11-01:

- Text: Inter Variable (roman and italic, rsms/inter 4.1), then `"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif`.
- Code: Geist Mono, then `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`.
- No Chinese font is named. Chinese takes the system font for the reader's language (PingFang SC on a Mac with Simplified Chinese).
- Regular weight 450; `font-synthesis: none`; `text-rendering: optimizeLegibility`; `-webkit-font-smoothing: antialiased`.
- Fonts are held until loaded (`font-display: block`) with no metric-adjusted fallback face.

Type sizes are not part of this decision: R-32's scale stands until Alex says otherwise.
