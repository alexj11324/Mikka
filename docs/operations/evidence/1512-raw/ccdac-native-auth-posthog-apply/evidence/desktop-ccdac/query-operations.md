# ccdac Native query-operation counts

Actual compiled source: `c6ffdf9d3c557c462047b9b81b55b3a0b4d7b9af`. Full primary API process windows; PKCE and background queries are included. Startup uses the first bundled/hosted pair only.

| Operation | Native login | Web login | Difference | Bundled startup | Hosted startup | Difference |
|---|---:|---:|---:|---:|---:|---:|
| /api/auth/[...all] | 22 | 22 | 0 | 0 | 3 | -3 |
| /api/desktop/begin | 1 | 0 | 1 | 0 | 0 | 0 |
| /api/desktop/return | 2 | 0 | 2 | 0 | 0 | 0 |
| /api/desktop/exchange | 8 | 0 | 8 | 0 | 0 | 0 |
| /api/desktop/rpc | 37 | 0 | 37 | 34 | 0 | 34 |
| /api/rpc | 0 | 36 | -36 | 0 | 36 | -36 |
| /api/workspace | 9 | 10 | -1 | 10 | 10 | 0 |
| /api/workspace/switcher | 4 | 8 | -4 | 4 | 8 | -4 |
| /api/live/ticket | 6 | 6 | 0 | 6 | 6 | 0 |
| /actions/coordinator/chat | 0 | 0 | 0 | 0 | 0 | 0 |
| /actions/coordinator/poll | 15 | 18 | -3 | 25 | 30 | -5 |
| /actions/coordinator/summaries | 6 | 10 | -4 | 6 | 10 | -4 |
| /actions/threads/poll | 6 | 10 | -4 | 7 | 8 | -1 |
| /actions/task-runs/read | 6 | 0 | 6 | 6 | 6 | 0 |
| /actions/issues/poll | 15 | 16 | -1 | 13 | 18 | -5 |
| /actions/projects/list | 1 | 2 | -1 | 1 | 2 | -1 |
| unattributed | 49 | 24 | 25 | 50 | 49 | 1 |
| **Total** | **187** | **162** | **25** | **162** | **186** | **-24** |

All 12 snapshots, 8 segments and 4 totals passed the partition checks. Login target failed; first startup target passed. The unattributed bucket remains in the totals and does not identify a causal route.
