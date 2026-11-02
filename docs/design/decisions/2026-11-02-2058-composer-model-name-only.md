# The collapsed model picker shows only the model

- Date: 2026-11-02
- Source: Alex: 「你在 picker 里边选，写一个账号名字，我觉得还可以理解；写账号邮箱也可以理解。但是最下边空间那么挤，你只需要写模型名字就行了呀，那个‘next’跟账号就没必要写上去了吧」。
- Rule: R-11; the composer model chip on web, desktop and mobile.
- Replaces: The account/next-message additions to the collapsed chip in #1056.

The collapsed composer control shows the existing model icon and model name,
without an account name, email address or Next / 下一条 prefix. Keep account
identification in the expanded picker, where it distinguishes connections.

This presentation change does not change when a new selection takes effect:
an active reply retains its frozen model and credential. Existing quota,
paid-fallback and failed-save recovery information remains available in its
appropriate notice or menu. Do not add native icon infrastructure for this
copy repair.
