# Contributing to Mikka

Thank you for helping improve Mikka.

## Before you start

- Read [`AGENTS.md`](AGENTS.md). Its rules apply to every contributor, human or
  coding agent.
- For design, spec or UI work, start with
  [`docs/design/README.md`](docs/design/README.md) and use the terms in
  [`docs/design/glossary.md`](docs/design/glossary.md).
- For anything larger than a small fix, open an issue first so the approach can
  be agreed before you write code.

## Pull requests

- Branch from `main` and keep each pull request to one change.
- Write commit messages in English, in the form `<type>: <description>`, where
  the type is one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`
  or `ci`.
- Run the source-only checks before you push:

  ```sh
  pnpm install
  pnpm check
  ```

- CI runs the full gate on every pull request, including the production build
  and browser tests. A pull request merges once the required checks pass.
- Never commit credentials. Project secrets live in Infisical Cloud.

## Contributor License Agreement

Before your first pull request can merge, you sign the
[Contributor License Agreement](CLA.md). A bot comments on the pull request
with instructions; you sign by replying with one sentence, and the signature
covers all your later contributions.

The agreement lets the project maintainer, and any company later formed to
develop Mikka, distribute your contribution under the project's license or
other terms. You keep the copyright in your work.

## License

Mikka is licensed under [AGPL-3.0-only](LICENSE). By contributing, you agree
that your contributions are also licensed under the AGPL-3.0-only, in addition
to the rights granted in the CLA. Send questions about the license or the CLA
to [legal@aspectlylabs.com](mailto:legal@aspectlylabs.com).

## Security

Report vulnerabilities privately to
[security@aspectlylabs.com](mailto:security@aspectlylabs.com), not in a public
issue.
