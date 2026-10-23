# Exact isolated service test decision (prepared, not launched)

## Bounded action

Enable only `cua-remote-service` from `cua-remote-service.yml.disabled` in the
existing CI workflow. It pulls the requested `trycua/cua-xfce:0.3.0` amd64 image
by immutable digest `sha256:0ac954ee74d5a3878484ddf5e4df7e83a1fdeeef1ec9a8d8744b76afcd0187fb`,
runs it on one disposable GitHub Linux runner for at most ten minutes, binds
only `127.0.0.1:3211`, and always removes the container. No host data mounts,
privileged mode, production endpoint, provider calls, API keys, credential
setup, external user access, image push/republication, or image rebuild.
Only a deliberately non-secret disposable token protects this isolated fixture.
No perception extension is installed or used; the test checks installed package
metadata and fails if cua-perception/cua-som is present. The image's declared
`cua-agent[all]` extras at its source revision do not list either package, but
that is not proof of every resolved binary package in the unpublished build.

The Mikka-owned GTK editor fixture and scripted streaming AI SDK model type a
fixed non-secret sentinel, wait for exact-operation test-owner approvals,
receive actual service PNG bytes back into the next model step, and read the
sentinel from that PNG with Tesseract. Wrong-token requests must fail. The only
published artifact is this disposable editor screenshot, retained three days.
No upstream FSL source/generated bindings are copied into Mikka. Existing
real-Postgres owner/policy/race/cancel and rendered browser tests remain separate.
The sample is syntax-checked, not service-validated: launch/protocol/GUI results
must not be called passing until the service actually runs.

## Exact bundled-version terms and provenance

- Registry source revision: `5da241ac4b4ff2cb165f3c48401391674d7f1dbd`.
  [Pinned Dockerfile](https://github.com/trycua/cua/blob/5da241ac4b4ff2cb165f3c48401391674d7f1dbd/libs/xfce/Dockerfile)
  installs published **spacesd v0.1.0** binary, separately from the MIT driver.
  [Image root license](https://github.com/trycua/cua/blob/5da241ac4b4ff2cb165f3c48401391674d7f1dbd/LICENSE.md)
  is MIT; it does not replace component licenses. The image also contains an
  ordinary third-party Linux distribution and applications with their own terms.
- [Exact spacesd version license](https://github.com/trycua/cua/blob/345ff6d9db458a9d37b0f420dc4555553f4a4ce5/libs/cua-spacesd/LICENSE)
  is **FSL-1.1-MIT**, copyright 2026 Cua AI, Inc. The v0.1.0
  [release](https://github.com/trycua/cua/releases/tag/cua-spacesd-v0.1.0)
  was published 2026-10-01T17:20:32Z. It is not currently MIT under the future
  grant: that grant becomes effective on the second anniversary of when the
  version was made available; this release date alone does not establish any
  earlier availability date.
- FSL expressly includes **“for your internal use and access”**, non-commercial
  education/research, and services to a compliant licensee as Permitted Purposes.
  The grant allows use/copy/modify/performance/display/redistribution for a
  Permitted Purpose. It is inaccurate to say FSL categorically forbids internal CI.
- FSL excludes **“making the Software available to others in a commercial
  product or service”** that substitutes for this software, another then-existing
  licensor product/service using it, or offers the same/substantially similar
  functionality. Internal CI is expressly listed; public commercial endpoint
  hosting/reuse or packaging the service into Mikka is not covered by this
  bounded test decision and must not be inferred from it. Whether a broader
  Mikka offering falls under Competing Use depends on facts not established here.
- Redistributed copies/modifications/derivatives must include a copy or link to
  these terms and retain copyright notices. No image redistribution is proposed;
  public screenshot artifacts are fixture output, not redistributed binaries.
  Patent-claim termination and trademark limits also remain in the license.
- [Docker service agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)
  states third-party images remain subject to their corresponding terms and
  conditions. It also provides service entitlements/request-rate limits and
  plan-specific restrictions. A public pull is not a blanket license to bundled
  software. This job does not use Docker Desktop or obtain a subscription;
  nothing here establishes a paid-plan requirement or the applicability of
  every subscription provision to GitHub's hosted runner. Registry refusal/rate
  limiting must fail the job, not trigger login, a paid plan, or a mirror.

## One specific decision, not legal authorization

Does the owner intend **only this isolated internal-CI use**, with no public
service, distribution or commercial availability of the bundled spacesd, and
want this exact prepared job enabled on that basis? That establishes intended
scope, not license compliance by approval. The text expressly permits internal
use; it does not establish all legal facts about a future Mikka product.
If intended use includes providing the service to customers, stop at the
prepared job and identify the concrete distribution/Competing Use issue with
its licensor rather than treating an owner “approve” as a license exception.

Neither answer blocks independent mock streaming, authenticated approval,
PNG continuation, database/race, UI or local-driver acceptance. Alex's final
real-model/real-Mac check remains his signoff, not a fake-model CI dependency.
