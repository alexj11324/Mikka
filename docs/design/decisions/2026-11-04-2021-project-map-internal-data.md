# Project map uses only Mikka records

- Date: 2026-11-04
- Source: Alex's latest instructions and [#1243](https://github.com/alexj11324/Mikka/issues/1243), confirmed in [PR #1253](https://github.com/alexj11324/Mikka/pull/1253#issuecomment-6641080327): 「只用 Mikka 自己的数据」；「任何情况下都不把 AI 对话写进用户的代码仓库」；「改完自己合并，不需要再评审」。
- Rule: —
- Replaces: the collection scope and review gate in the earlier draft of project-map-rfc.md. The accepted vertical layout remains unchanged.

The project map covers bot chats, tasks dispatched by Mikka to Claude Code / Codex on local devices, servers or cloud machines, run messages and chunks, questions and answers, Factory reviews and acceptances, Artifacts and PR references already held by Mikka.

Work performed outside Mikka is neither collected nor displayed. No integration may write AI conversations into a user's code repository. Only decision facts and their structured source references are new storage; the map is derived from those facts and existing records.

The backend owner proceeds through #1244, #1245 and #1247, self-merging each PR once applicable CI passes and then checking deployment and real acceptance. There is no intermediate Alex review gate. #1246 is out of scope. #1248 remains owned by the separate frontend session.

The backend handoff is posted only after #1247 is live, with the API contract, real redacted examples, pagination, filters and known limits.
