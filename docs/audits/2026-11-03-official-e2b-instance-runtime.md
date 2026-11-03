# Untouched official E2B instance experiment

Tracking #1131, #1124. User explicitly requires complete template/package
preservation; another session is preparing an issue handoff. No production
subscription acceptance is claimed here.

The historical E2B worker-template workflow (403313168) was manually disabled
by this session in response to that requirement. No existing E2B template was
updated or deleted. Shared coordination and clarification:
https://github.com/alexj11324/Mikka/pull/1130#issuecomment-6606665797
https://github.com/alexj11324/Mikka/issues/1131#issuecomment-6606707902
The direct cross-session app tools are unavailable on this host; GitHub notes
were posted, but receipt by the other session is not asserted.

E2B documents derived templates as a normal method of preinstalling dependencies
and reducing startup time: https://docs.e2b.dev/template/quickstart . The
demonstrated defect was stripping required official package contents, not the
existence of a derived template itself. The user's preservation requirement
still governs implementation.

## Real isolated official Codex instance

- Source commit: fd4f9e7c4ebb779e8d054c42f662b81098b5b420.
- Worker input digest: f3f90d4aeb94b74cded469c936993bf1e1814fa2.
- Newly created sandbox: iz4b2l72z1adt5qfqe4rp, official `codex` template.
- The official CLI package contained 48 files before and after bootstrap.
  Both file-list/content manifests had SHA256
  ed99358cb1eacd66a5e61567212e8099c9e1053ba4c607304638e9493be25e61.
- The instance kept official Codex 0.166.0. Node 24.19.0, the exact public Git
  source and Mikka dependencies were added beneath `/opt/mikka`; the official
  CLI files remained byte-for-byte unchanged.
- The actual compiled worker model probe exited zero, reporting
  `gpt-5.6-luna` and the requested Claude model slots. No provider credential,
  paid prompt or fabricated auth was used by this experiment.
- The newly created instance was paused to retain evidence. The protected
  Acme sandbox was never connected to or changed.

This evidence belongs to the stated commit. Subsequent integration with #1130
must receive its own checks; this result is not relabeled as testing it.

## Current integration and outstanding work

The branch retains #1130's error classification, code-mode helper PATH and
companion regression, then preserves entire verified package archives and
extracted trees, using additive aliases. Replaced and older installations are
retained. Eight installer/native companion tests and 18 isolated PostgreSQL
machine/provisioning tests pass after integration. Unit coverage checks official
template selection, configuration refusal and actual bootstrap receipts.

Still required: official desktop/Claude instance bootstrap, runtime release
configuration and publishing without template mutation, complete required CI,
and fixed-version real official-subscription prompt → dispatch → E2B Agent →
independent review/verify → owner acceptance and continuation. #1129 additionally
needs a real wrong-repository-to-correct-repository Agent run. A successful model
probe or deterministic regression is not a completed subscription delivery.
