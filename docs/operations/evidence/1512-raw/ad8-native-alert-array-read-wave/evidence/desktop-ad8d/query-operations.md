# Desktop ad8: observed SQL counts

Source: `212b65491909f064a732c6c1af69a54a6022f184`; candidate: `ad8d257129989be43a3cb92e48ccd1197a6d096c`.

All background and PKCE calls remain included. Startup is the first pair only.

| Operation | Native login | Web login | Difference | Bundled startup | Hosted startup | Difference |
|---|---:|---:|---:|---:|---:|---:|
| /api/auth/[...all] | 22 | 21 | 1 | 0 | 3 | -3 |
| /api/desktop/begin | 1 | 0 | 1 | 0 | 0 | 0 |
| /api/desktop/return | 2 | 0 | 2 | 0 | 0 | 0 |
| /api/desktop/exchange | 9 | 0 | 9 | 0 | 0 | 0 |
| /api/desktop/rpc | 36 | 0 | 36 | 35 | 0 | 35 |
| /api/rpc | 0 | 36 | -36 | 0 | 36 | -36 |
| /api/workspace | 10 | 10 | 0 | 10 | 10 | 0 |
| /api/workspace/switcher | 4 | 8 | -4 | 4 | 8 | -4 |
| /api/live/ticket | 6 | 6 | 0 | 6 | 6 | 0 |
| /actions/coordinator/chat | 0 | 0 | 0 | 0 | 0 | 0 |
| /actions/coordinator/poll | 18 | 18 | 0 | 28 | 20 | 8 |
| /actions/coordinator/summaries | 8 | 10 | -2 | 8 | 10 | -2 |
| /actions/threads/poll | 10 | 10 | 0 | 8 | 8 | 0 |
| /actions/task-runs/read | 6 | 0 | 6 | 6 | 3 | 3 |
| /actions/issues/poll | 16 | 16 | 0 | 14 | 11 | 3 |
| /actions/projects/list | 1 | 2 | -1 | 1 | 2 | -1 |
| unattributed | 49 | 46 | 3 | 39 | 41 | -2 |
| **Total** | **198** | **183** | **15** | **159** | **158** | **1** |

12 original snapshots, 8 segment deltas and 4 whole-window deltas each match the exact 17-key partition and original queryCalls. Neither query-count target passed.
