# G #2506 file coverage

This repository's review queue is pinned to `b19eed9081d9858686d57547e7afcec73d6e9005`, root tree `4f28d0ea63c551f03617afae99ed0305a5d59d76`. Rows in paths-*.csv are ordered by the tracked path. Each row carries its object ID and mode, so an identical path at another revision can be compared explicitly. The module and type labels are provisional inventory. The **review_record** and **remediation** columns record the path-specific evidence when available. reviews.jsonl resolves those conclusions to their source commit and object ID. The issue carries the earlier nine merged fixes and the cross-repository index.

| Code path status | Count at this ledger revision |
|---|---:|
| complete | 102 |
| partial | 28 |
| prior-partial | 36 |
| unreviewed | 6390 |

A partial entry has evidence for specific behavior/symbols. Only complete entries count toward the semantic numerator. Unreviewed and prior-partial paths remain in the queue. Non-code inputs can change execution and remain in scope; file classification changes when consumers prove they should be treated as implementation. The manifest does not certify that an asset is unreferenced or that any generated path matches its source. All base-to-tip changes must be reconciled separately before closure.

## Main differences

main-delta.jsonl records 28 distinct changed paths between this fixed start and a5f463a7db7a2ecdfa6dc0f34b218fe5f8d02660, tree 8dd2488cedc3a9393f5518b48aa88787ea264fb5. It includes before/after Git IDs and explicit open follow-up for affected chains. An empty tip object is a deletion. Refresh using git ls-tree -rz --full-tree at each root, git diff --name-status -M with both exact commits, then examine all affected consumers. Keep merged-PR evidence and whole-file semantic evidence distinct. The current task and original nine are indexed in https://github.com/alexj11324/Mikka/issues/2506.

changes.jsonl indexes source/merge IDs, original PR rationale, official links cited in that record, and the isolated receipt where available. Check the PR and its protections for current state before taking further action.

api-entries.jsonl maps all 324 generated API route declarations (430 HTTP methods) to their exact source objects, template, router path, lazy loading, effective methods and duration. Source hashes and matcher coverage have been checked for every entry. Audit each handler and its full downstream chain using its separate path row.
