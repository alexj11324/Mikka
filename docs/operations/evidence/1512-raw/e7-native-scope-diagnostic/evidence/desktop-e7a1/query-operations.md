# Fixed query-operation counts

| Operation | Native login | Web login | Difference | Bundled first startup | Hosted first startup | Difference |
|---|---:|---:|---:|---:|---:|---:|
| /api/auth/[...all] | 22 | 22 | 0 | 0 | 3 | -3 |
| /api/desktop/begin | 1 | 0 | 1 | 0 | 0 | 0 |
| /api/desktop/return | 2 | 0 | 2 | 0 | 0 | 0 |
| /api/desktop/exchange | 8 | 0 | 8 | 0 | 0 | 0 |
| /api/desktop/rpc | 35 | 0 | 35 | 10 | 0 | 10 |
| /api/rpc | 0 | 36 | -36 | 0 | 35 | -35 |
| /api/workspace | 10 | 10 | 0 | 5 | 10 | -5 |
| /api/workspace/switcher | 4 | 8 | -4 | 2 | 8 | -6 |
| /api/live/ticket | 6 | 6 | 0 | 6 | 6 | 0 |
| /actions/coordinator/chat | 0 | 0 | 0 | 0 | 0 | 0 |
| /actions/coordinator/poll | 14 | 18 | -4 | 2 | 30 | -28 |
| /actions/coordinator/summaries | 6 | 10 | -4 | 1 | 10 | -9 |
| /actions/threads/poll | 8 | 10 | -2 | 1 | 8 | -7 |
| /actions/task-runs/read | 6 | 0 | 6 | 3 | 6 | -3 |
| /actions/issues/poll | 14 | 16 | -2 | 1 | 18 | -17 |
| /actions/projects/list | 1 | 2 | -1 | 1 | 2 | -1 |
| unattributed | 49 | 24 | 25 | 22 | 40 | -18 |

Original whole-process windows; PKCE and background work are retained. Login remains above Web. The first startup comparison contains requests completing after the window; no causal reduction is claimed.
