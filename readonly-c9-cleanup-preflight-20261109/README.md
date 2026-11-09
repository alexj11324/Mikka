# Exact c9 cleanup offline preflight — 2026-11-09

This evidence records an offline preflight of cleanup source `e5a50fa1d227eca754eb41dc0fc39a14ffd5d377`. It does not record activation or execution of cleanup.

The first tool image URL expired at 13:37:10 UTC before this worker read any bytes. Root recovered a tool image of the same artifact 13677458654. This worker fetched that recovered image once, verified the exact 925-byte ZIP digest, and extracted its sole `receipt.json` member once to a temporary receipt file. The subsequent positive and negative guard tests reread that same cached ZIP in memory; they did not download or obtain another artifact. It did not invoke the GitHub artifact download API. Signed image URLs, ZIP bytes, receipt bytes and raw appClientId are intentionally absent from this evidence.

The measured receipt is 2132 bytes, SHA-256 `80031945234e34264c558f830bd64bfa651858e69dbfdfa6354b62deb2a2022d`. Safe archive metadata and the appClientId length/hash are in archive-metadata.json.

The exact final workflow was supplied to Python in the temporary Node24 Linux sandbox, without production credentials. All 7 Python heredocs compiled. The workflow's actual verified_receipt function passed the original ZIP positive case and 14 negative cases: outer size/digest, manifest, three invalid paths, duplicate, extra/wrong member, symlink, member size/digest, malformed ZIP and encrypted member. No network or production API was called by this test.

archive-guard-tests.py is the exact executed Python script. test-command-result.json and test-command-stdout.json are the original tool results for that test; test-stdout.txt is its exact stdout. The execution command used python3 -c with the script and exact workflow content as separate arguments. Reproduction requires the original protected ZIP and receipt at the temporary paths named in that script; neither input is published here.

Static review confirms the source/attempt/artifact bindings, three exact-main GETs with time guards before and after each, the original five OIDC secret scopes and both concurrency queues. The two-minute entry adjustment is represented by entry 13:49 and a 10-minute job, retaining hard end 13:59. The download helper still requires the GitHub 302 and a permitted HTTPS blob host, removes Authorization on the redirected request, refuses subsequent redirects, bounds bytes and checks the ZIP digest. The ZIP verifier permits only a single regular receipt.json with its pinned bytes/digest.

Relative to c9, GitHub comparison reports only the workflow changed; all five helper/test files remain unchanged. Runtime cleanup verifies the saved receipt hash and exact child state, then revokes/disconnects that child without invoking Owner refresh.

VM `sbx_dgRWQ37UPkIb91MNZmIilG1Bcf39` was stopped at 2026-11-09T13:44:11.228Z; a fresh GET confirmed stopped. Its create, stop and get results are preserved. No ref was moved for this evidence.

The command-result tool truncates long argument strings after 2000 characters; its original truncation markers are preserved. The complete executed script is stored separately from the exact tool-request input, and the complete workflow is preserved as workflow.exact.yml. The captured script prefix matches that tool-request input.
