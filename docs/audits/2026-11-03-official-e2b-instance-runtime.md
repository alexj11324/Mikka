# Untouched official E2B instance experiment

Tracking #1131, #1124. User explicitly requires complete template/package
preservation; formal handoff #1132 is now accepted. No production
subscription acceptance is claimed here.

The historical E2B worker-template workflow (403313168) was manually disabled
by this session in response to that requirement. No existing E2B template was
updated or deleted. Shared coordination and clarification:
https://github.com/alexj11324/Mikka/pull/1130#issuecomment-6606665797
https://github.com/alexj11324/Mikka/issues/1131#issuecomment-6606707902
The direct cross-session app tools are unavailable on this host. The source
session explicitly acknowledged coordination and stopped implementation:
https://github.com/alexj11324/Mikka/issues/1131#issuecomment-6606778832 .
Takeover confirmation: https://github.com/alexj11324/Mikka/issues/1132#issuecomment-6606802474 .

E2B documents derived templates as a normal method of preinstalling dependencies
and reducing startup time: https://docs.e2b.dev/template/quickstart . The
demonstrated defect was stripping required official package contents, not the
existence of a derived template itself. The user's preservation requirement
still governs implementation. The later documentation-priority instruction is
recorded in decision 2026-11-03-1515; these requirements do not conflict.

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

## Real desktop and Claude instances

Both used source c6c21aed532c05f1288f75a1aaa81bc75d0054b8 and worker digest
21946035e2d5d114498b33eb03bc6511ef408134. For `/usr/local`, `/usr/bin` and
`/home/user/.config`, file paths and contents were hashed before/after bootstrap:

| Official kind | Own sandbox | Checked files | Matching manifest SHA256 |
| --- | --- | --- | --- |
| desktop | imt86ecidmcrkl9bscaqi | 3515 | 69fb689a524c73531bbd161af238fe9fa5fb905235c4bced00712161820fbef4 |
| claude | i5j50k9po0cooe761qcxv | 1931 | 90227ba99be09039204560a38c14d653dfa417d282173583b086adc314feed51 |

Both bootstrap commands and compiled worker model probes exited zero. On the
desktop instance, actual gateway startup returned HTTP 401 without a grant;
display 73 and both private Unix VNC sockets became ready. Instances were
paused afterward. These checks did not invoke a model or count as acceptance.
They do not assert that every OS path was hashed. The replacement validation
script additionally compares links, directories and permissions in these roots.

## Cancelled publication side effects

Release 41655279324 finished cancelled, but its build succeeded and the publish
step wrote production configuration before cancellation. Read-only verification
found desktop sexfzio1s90fod7ij4d7, Claude 963qsaix9823ndwpdmxb, Codex
9hv117mvz0aekutp0fph and worker 5f0a357c7575ded580c79ed090b47e7bafa23773.
The normal production version endpoint subsequently identified READY deployment
dpl_9ggCeiC27PvySzcHEjZpF7ijPoVZ, Git commit
4fee9a2cc0913d742ab55a7ab6e32fa1cf8faf58. It does not include #1122. The old
workflow remains disabled_manually. No rollback or replacement publication has
been performed by this takeover check.

Still required: runtime release
configuration and publishing without template mutation, complete required CI,
and fixed-version real official-subscription prompt → dispatch → E2B Agent →
independent review/verify → owner acceptance and continuation. #1129 additionally
needs a real wrong-repository-to-correct-repository Agent run. A successful model
probe or deterministic regression is not a completed subscription delivery.
