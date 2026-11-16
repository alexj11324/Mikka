# G #2506 file coverage

This repository's review queue is pinned to `b19eed9081d9858686d57547e7afcec73d6e9005`, root tree `4f28d0ea63c551f03617afae99ed0305a5d59d76`. Rows in paths-*.csv are ordered by the tracked path. Each row carries its object ID and mode, so an identical path at another revision can be compared explicitly. The module and type labels are provisional inventory. The **review_record** and **remediation** columns record the path-specific evidence when available. reviews.jsonl resolves those conclusions to their source commit and object ID. The issue carries the earlier nine merged fixes and the cross-repository index.

| Code path status | Count at this ledger revision |
|---|---:|
| complete | 177 |
| partial | 29 |
| prior-partial | 36 |
| unreviewed | 6314 |

A partial entry has evidence for specific behavior/symbols. Only complete entries count toward the semantic numerator. Unreviewed and prior-partial paths remain in the queue. Non-code inputs can change execution and remain in scope; file classification changes when consumers prove they should be treated as implementation. The manifest does not certify that an asset is unreferenced or that any generated path matches its source. All base-to-tip changes must be reconciled separately before closure.

## Main differences

main-delta.jsonl records 28 distinct changed paths between this fixed start and a5f463a7db7a2ecdfa6dc0f34b218fe5f8d02660, tree 8dd2488cedc3a9393f5518b48aa88787ea264fb5. It includes before/after Git IDs and explicit open follow-up for affected chains. An empty tip object is a deletion. Refresh using git ls-tree -rz --full-tree at each root, git diff --name-status -M with both exact commits, then examine all affected consumers. Keep merged-PR evidence and whole-file semantic evidence distinct. The current task and original nine are indexed in https://github.com/alexj11324/Mikka/issues/2506.

changes.jsonl indexes source/merge IDs, original PR rationale, official links cited in that record, and the isolated receipt where available. Check the PR and its protections for current state before taking further action.

api-entries.jsonl maps all 324 generated API route declarations (430 HTTP methods) to their exact source objects, template, router path, lazy loading, effective methods and duration. Source hashes and matcher coverage have been checked for every entry. Audit each handler and its full downstream chain using its separate path row.

## 2026-11-16 World and main reconciliation

Four previously unreviewed World Node, business binding and SQL catalog files now have individual source conclusions. The fixed source and exact package runs are in reviews.jsonl. In addition to its earlier snapshot, main-delta.jsonl now enumerates the union of changed names between the fixed tree and a1e31323a381b97d8e0a7b7d098fadb3c4b767e3 including old/new modes and Git objects. 1350 changed names (974 modified, 361 added, 15 deleted); 8342 tracked paths on this main. This inventory retains deleted paths and represents a rename as one removal and one addition. It does not certify the changed consumers. G-046 source ad84143b9665375d278fbe31f35a7e22d87f610f is tracked by PR #2613.

Sixteen Expo route entries now have independent records for the exact reachable path, screen/export and consumer at the fixed SHA. Expo Router 58.0.29 resolved all 16 entries on both iOS and web; this was a route-resolution test, with no screen render, device use or backend mutation. The screen destinations remain separately accounted. [Expo file-based routing](https://docs.expo.dev/router/basics/core-concepts/)

13 previously unreviewed Mobile files now bind the real root and tab entries, settings provider, preference serialization, identity cache, sheet configuration and push routing to their fixed blobs and individual consumers. The setting writer exposed G-049 / #2620. Expo resolved all seven layout entries per platform. Two supporting test groups passed 43/43 and 14/14 on the fixed checkout.

Full name/mode/blob difference inventory refreshed through 295f53ba18177329d162bb62da44d7e66bb46ac6 (8344 paths): 1364 changed names vs fixed baseline, {'modified': 986, 'added': 363, 'deleted': 15}. Relative to a1e31323a381b97d8e0a7b7d098fadb3c4b767e3, 40 names changed in eight ordinary main merges. 15 G-affected names link the exact tested change to its merge and receipt. The remaining names and earlier changes to these files stay in scope; owner B/E merges remain attributed to their PRs.

Fourteen fixed source paths cover gateway admission, DO wiring, native WebSocket presence, Eve image configuration, the retired restart machine, and the actual G-048 and G-015 consumers. Both native 90-second expiry and recovery paths were run in isolated workerd, with supporting route and Eve scopes recorded per path.

15 additional settings and workspace sources identify each route, writer, authoritative read and the historical one-step drawer mover. Thirteen meet the fixed-source semantic criteria; the legacy singular picker and same-key order hydration remain partial. Source, tests and current consumer are recorded for G-052 #2627.

14 fixed API paths trace server-only aliases, request/header/cookie scopes, Next adaptation, deferred response disposal, and matching original regressions. Each path now records its concrete consumer and the runtime evidence. Locale fallback used to parse the entire request cookie jar twice; G-057 tracks the verified consumer correction.

Full Git tree inventory at 834571eb2383fc2f0768142d1b38a1db5217d158: 8350 paths, 1384 changed names against fixed base b19eed9081d9858686d57547e7afcec73d6e9005 ({'modified': 1000, 'added': 369, 'deleted': 15}). From the preceding 295f53ba snapshot 42 names changed across ten ordinary main merges. Eight G-affected file deltas carry their precise acceptance; other main changes preserve their integrating owner and remain in the review queue. G-055 closes the fixed workspace order hook behavioral gap.
