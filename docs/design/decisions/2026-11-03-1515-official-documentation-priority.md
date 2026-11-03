# Follow official documentation when instructions conflict

- Date: 2026-11-03
- Source: Alex, this task: “请严格按照官方的文档行事，如果我的指令和官方文档有冲突，依照官方文档进行处理”.
- Rule: —
- Replaces: conflicting interpretations of earlier instructions, where an actual official requirement is established.

Use the relevant current/version-matched official documentation as the authority
for installation, integration and release requirements. Cite the specific
requirement when it conflicts with an earlier instruction; an optional supported
method is not a mandatory requirement.

E2B's [template quickstart](https://docs.e2b.dev/template/quickstart) explicitly
supports custom templates and `fromTemplate` layering for preinstallation and
startup performance. It does not require a derived template, stripping Codex
packages or deleting official files. The earlier preservation decision therefore
still applies. The confirmed defect is our incomplete package extraction, not
the existence of derived templates.

The [official Codex repository installation section](https://github.com/openai/codex#installing-and-running-codex-cli)
documents the standalone installer, npm, Homebrew and platform release downloads.
Keep the official preinstalled CLIs intact. Mikka's separately pinned package
loader is custom integration code, not an installation recipe supplied by E2B;
it must preserve the complete downloaded package and validate actual tool use.

The original template definitions stay unchanged and the historical publishing
workflow stays disabled. The replacement validates new official instances,
then publishes a source-commit/worker/configuration pair for that same application
commit. Full subscription and owner-acceptance evidence is still required.
