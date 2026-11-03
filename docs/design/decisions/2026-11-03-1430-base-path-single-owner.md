# One owner for the application URL prefix

- Date: 2026-11-03
- Source: Alex: 「之前好像也是把链接加了两次，有什么方法可以阻止他这样去做吗？能够一劳永逸地解决这个问题」.
- Rule: R-82 (navigation).

Next Link, Next/localized routers and server redirects own the deployment prefix.
Pass an application path such as `/api/chat/attachments/<id>` to them, without
`/mikka`. Raw fetch, native anchors and clients outside Next use `withBasePath`.
The helper is idempotent, preserves query/hash suffixes and leaves external URLs
alone.

`navigation/double-base-path` runs from the normal UI lint/build and source CI
checks. It rejects prefixed literals, `withBasePath` calls, imported aliases,
local variables/template suffixes and URL-object pathnames passed to framework
navigation. Regression fixtures exercise both rejections and legitimate raw
fetch/anchor/external-link usage. The attachment link fixture renders Next's
real Link with `/mikka` configured and checks the actual href.

The first repository audit caught the attachment open/download links and three
sign-in/sign-up redirect call sites. Their framework targets now use raw
application paths; raw authentication continuation URLs keep their transport
prefix. Production-build API acceptance verifies the authenticated redirect
Location, without following an OAuth provider or changing account linking.

This prevents the known duplicate-prefix patterns before release. It does not
claim to statically prove the correctness of every dynamically constructed URL.

Reference: [Next.js basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath).
