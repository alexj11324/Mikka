# Phone pushes, desktop notifications and briefing highlights are Decisions API answers

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「这个东西很便宜，全部交给 Decision API 来处理，确认卡片之类的全部交给。」
- Rule: R-20, R-21
- Replaces: the event-kind table in `lib/push-reasons.ts`, the "waiting or failed always notifies" rule of the desktop app (2026-10-31), the level/required/age order of briefing highlights, and the preset `result` tier on OAuth agent messages

- Whether a Coordinator reply also goes to the person's phone, and as which
  kind (需要你决策, 待审阅, 线程完成, 每日简报), is one Decisions choice that
  reads the events the reply answers and the reply. A verification code is
  described, not quoted. The person's 通知 switches and chat mute still apply
  after it. No answer pushes nothing; the reply is in the chat.
- Whether a run entering 等你, failing, or finishing (while 线程完成 is on)
  raises a desktop system notification is a Decisions predicate per run. No
  answer shows nothing; the Dock badge still counts 等你.
- Which suggestions the morning briefing names (at most three) is the
  Decisions API's pick. No answer names none; the counts still go out.
- A message an OAuth agent sends the Coordinator has no preset tier; triage
  (the Decisions API) classifies it like any runtime event.
