# 1bd Desktop query operation counts

Run 42391049816 attempt 1; actual source `49d93ce3feb348fdfb05bd30e9d0ae114066da25`.

Whole primary API windows are unchanged. Native PKCE and background calls are included. Startup is the first bundled/hosted Electron pair. Counts are PostgreSQL client query calls, not RPC requests.

| Operation | Native login | Chromium login | Bundled startup | Hosted startup | Login difference | Startup difference |
|---|---:|---:|---:|---:|---:|---:|
| /api/auth/[...all] | 21 | 22 | 0 | 3 | -1 | -3 |
| /api/desktop/begin | 1 | 0 | 0 | 0 | 1 | 0 |
| /api/desktop/return | 2 | 0 | 0 | 0 | 2 | 0 |
| /api/desktop/exchange | 8 | 0 | 0 | 0 | 8 | 0 |
| /api/desktop/rpc | 35 | 0 | 34 | 0 | 35 | 34 |
| /api/rpc | 0 | 36 | 0 | 36 | -36 | -36 |
| /api/workspace | 10 | 10 | 10 | 10 | 0 | 0 |
| /api/workspace/switcher | 4 | 8 | 4 | 8 | -4 | -4 |
| /api/live/ticket | 6 | 6 | 6 | 6 | 0 | 0 |
| /actions/coordinator/chat | 0 | 0 | 0 | 0 | 0 | 0 |
| /actions/coordinator/poll | 40 | 44 | 42 | 50 | -4 | -8 |
| /actions/coordinator/summaries | 6 | 10 | 6 | 10 | -4 | -4 |
| /actions/threads/poll | 6 | 10 | 6 | 8 | -4 | -2 |
| /actions/task-runs/read | 6 | 0 | 5 | 6 | 6 | -1 |
| /actions/issues/poll | 14 | 16 | 12 | 18 | -2 | -6 |
| /actions/projects/list | 1 | 2 | 1 | 2 | -1 | -1 |
| unattributed | 49 | 46 | 43 | 44 | 3 | -1 |

All 12 cumulative snapshots use PID 29218; unknown readings are zero. The 17-operation partition conserves every snapshot, phase and total.

| Window | Physical started/completed | Logical started/completed | Cross start/end | Unpaired or unfinished |
|---|---:|---:|---:|---:|
| nativeLogin | 7/7 | 20/20 | 0/0 | 0 |
| webLogin | 17/17 | 17/17 | 0/0 | 0 |
| startup-bundled | 5/5 | 19/19 | 0/0 | 0 |
| startup-hosted | 19/19 | 19/19 | 0/0 | 0 |

All reported action statuses are 200. RPC counts do not allocate SQL cost. Original action and phase detail remains in summary.json.

The current paired budgets are met (209 <= 210; 169 <= 201). No cross-run causal improvement or production acceptance is claimed.
