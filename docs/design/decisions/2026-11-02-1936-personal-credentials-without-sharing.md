# Personal credential use never requires team sharing

- Date: 2026-11-02
- Source: Alex in the subscription/settings review: 「个人订阅始终要对这个人是可用的」「只有分享给其他人时，才需要另行授权。包括密钥也是一样，个人始终拥有自己密钥的使用权，是否分享看个人」「尽量不要设计得太过复杂，毕竟我们这个不是专门的密钥产品」。
- Rule: Reaffirms [2026-11-01-2240](2026-11-01-2240-own-credentials-always-usable.md).
- Replaces: —

Connecting one's subscription or personal API key authorizes one's own Bots
and Agents in every workspace one belongs to. No share row, workspace-use
switch or administrator's permission to share is needed for personal use.
Changing workspaces does not require reconnecting or copying the credential.

Sharing authorizes other people in the chosen team workspace. Turning it
off, or an administrator disabling sharing, affects only those other people.
Pausing or disconnecting one's credential is a separate explicit action.
Actual provider authorization, supported models and allowance still apply;
their errors must not be presented as missing workspace sharing permission.

Personal resources remain account-owned; team project secrets remain
workspace/project resources. Reuse existing workspace permissions rather
than introducing custom-role editors, per-environment permission matrices
or approval workflows in this repair. The competitor comparison is
research, not authorization to add those capabilities or change an unresolved
member secret-management policy.

Regression coverage must include no sharing, another workspace, and sharing
disabled by an administrator, for both own subscriptions and own API keys.
Other people's use must still stop after sharing or membership is revoked.
