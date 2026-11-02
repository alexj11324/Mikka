# Model lists show only what was reported

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session, after 设置 › Bot 与 Agents › 任务默认 showed Codex with the model `opus` (Claude's mark), a list holding only `opus`, and 未保存 on save: 「模型列表只能用 CLI 或 daemon 回报上来的值，不许写死。」
- Rule: — (R-74 marks stand)
- Replaces: [decisions.md](../decisions.md) 2026-10-30 row "No 自动 anywhere in execution settings", as to the initial value "on its `opus` slot" only; the rest of that row stands.

A model picker (the task defaults, a label rule, and anything that suggests a
default) lists only models a CLI or daemon reported at that place: the
device's model slots or models, and on Mikka Cloud the connected account's
model catalogue. No model name is written into the code as an option, a
default or a stand-in; a guard test (`lib/model-options-source.test.ts`)
fails on one.

- Nothing reported: the picker says 还没有可用模型, and its list heading keeps
  重新检测. No placeholder model is offered.
- Default model: the one the CLI marks default (`defaultModelSlot`); when it
  marks none, no model is chosen and the person picks one.
- Changing the Agent or the place keeps the model only if the new one reports
  it; otherwise it is cleared, never carried over.
- A saved model the place no longer reports shows as 「<model> · 不可用」 and is
  not offered as a choice. A choice without a model is not saved until a model
  is picked.
