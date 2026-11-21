# Thread titles follow Codex's title generation

- Date: 2026-11-19
- Source: Alex: 「查一下 Codex 的仓库，看看 codex 标题和长度怎么做的，我们采纳 codex 的标题生成的做法，避免太长。」 Reference: openai/codex, `codex-rs/tui/src/app/thread_title.rs`.
- Rule: R-01; the short-title contract.
- Replaces: the generated and manually entered Latin title limit (6 words, 60 characters) in [2026-11-10-1341](2026-11-10-1341-sidebar-short-title-limits.md). The CJK limit, database contract, compact display and deterministic fallback stay as that decision states.

The small model that names a thread follows Codex's thread titles:

- Latin text: at most 36 characters and under 5 words where possible (Codex's
  `THREAD_TITLE_MAX_CHARS` is 36). CJK text keeps its 12-character bound, since
  36 CJK characters would be far longer on screen than 36 Latin ones.
- The instructions ask for a single-line task title that starts with an
  imperative verb, capitalizes only the first word unless names or code terms
  need otherwise, is written in the conversation's language, has no quotes,
  Markdown or trailing punctuation, and does not answer the request.
- The model answers through structured output with a `maxLength` of 36 on the
  title. An answer that fails the schema is still read from its text and cut,
  as Codex does; nothing is lost to an overlong answer.
- The conversation text sent to the model is held to 960 UTF-8 bytes
  (Codex's `THREAD_TITLE_PROMPT_MAX_BYTES`). Only the conversation is bounded;
  the workspace's naming instructions travel separately in the instructions.
- Cleaning trims quotes (including backticks) and trailing `. ? !` and their
  full-width forms, then holds the result to the limit without ending inside
  a word.

Kept from Mikka, unlike Codex: issue keys and dates are still left out of the
title, because lists draw the task code beside it. The model uses the independently
managed LiteLLM alias `mikka-title` (`TITLE_MODEL`); Codex's own title model is
not used. Instructions are in Chinese; the generated title follows the task
language. A manual rename still wins: `WRITE_THREAD_TITLE` never overwrites a
title a person set.

The shorter Latin limit is stricter than the stored-title constraint from
2026-11-10-1341, so existing rows remain valid and no migration is needed.
The 5-word / 36-character bound applies to newly generated and manually entered
titles. Compact navigation (`compactTaskTitle`) keeps its existing 6-word /
60-character display contract for fallbacks and stored titles, including citation
labels. Stored titles are not rewritten.
