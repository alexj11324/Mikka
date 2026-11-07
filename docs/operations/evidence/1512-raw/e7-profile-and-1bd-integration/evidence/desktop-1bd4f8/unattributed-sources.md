# 1bd Desktop unattributed-source refinement

Exact source `49d93ce3feb348fdfb05bd30e9d0ae114066da25`; 75 fixed source labels. Historical reports were not reclassified.

| Source | Native login | Chromium login | Bundled startup | Hosted startup |
|---|---:|---:|---:|---:|
| /api/agent/sessions | 2 | 2 | 1 | 2 |
| /api/computer/events | 0 | 0 | 0 | 0 |
| /api/conversations | 10 | 10 | 10 | 10 |
| /api/devices/enrollment | 3 | 0 | 3 | 3 |
| /api/pending-actions | 2 | 2 | 2 | 2 |
| /api/settings/preferences | 2 | 0 | 2 | 2 |
| noScope | 0 | 0 | 0 | 0 |
| otherScoped | 30 | 32 | 25 | 25 |
| Refined unattributed total | 49 | 46 | 43 | 44 |

All 24 refinement rows (12 snapshots, 8 segments, 4 totals) conserve the original unattributed partition. Zero values are justified by the complete valid 75-key snapshot; missing rows are never treated as zero.

otherScoped is unresolved. These labels count actual query calls under source-owned scope and do not infer requests, SQL text or user identity. computer/events was zero in all four measured windows, so this receipt does not attribute the paired result to the Feed fix.
