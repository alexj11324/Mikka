# GitHub entry

> Target contract. Today `github_repository_installations` is keyed by the
> person and the repository (no workspace column), and a GitHub webhook
> refreshes publications and ingests suggestions; it does not start a thread.
> Until the workspace binding lands, this page describes the intended
> contract, not current behavior.

A GitHub App installation is bound to one Mikka workspace. A `pull_request`, `issues` or `issue_comment` event in an installed repository starts one thread in that workspace and records the installation, repository, issue/PR number and delivery id as its origin. The thread's final reply, PR link and status are written back to the same GitHub issue/PR. An event from an installation bound to another workspace is refused.
