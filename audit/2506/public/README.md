# G #2506 file coverage

This repository's review queue is pinned to `b19eed9081d9858686d57547e7afcec73d6e9005`, root tree `4f28d0ea63c551f03617afae99ed0305a5d59d76`. Rows in paths-*.csv are ordered by the tracked path. Each row carries its object ID and mode, so an identical path at another revision can be compared explicitly. The module and type labels are provisional inventory. The **review_record** and **remediation** columns record the path-specific evidence when available. reviews.jsonl resolves those conclusions to their source commit and object ID. The issue carries the earlier nine merged fixes and the cross-repository index.

| Code path status | Count at this ledger revision |
|---|---:|
| complete | 18 |
| partial | 3 |
| prior-partial | 36 |
| unreviewed | 6499 |

A partial entry has evidence for specific behavior/symbols. Only complete entries count toward the semantic numerator. Unreviewed and prior-partial paths remain in the queue. Non-code inputs can change execution and remain in scope; file classification changes when consumers prove they should be treated as implementation. The manifest does not certify that an asset is unreferenced or that any generated path matches its source. All base-to-tip changes must be reconciled separately before closure.
