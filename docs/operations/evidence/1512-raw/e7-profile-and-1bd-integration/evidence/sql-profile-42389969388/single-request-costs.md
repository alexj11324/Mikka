# Fixed e7 sequential HTTP/PG costs

- Run: 42389969388 / attempt 1; actual source `383da169d23b9cb6bfae1951ef862f43919a89c8`.
- These are per-request observations, not a reconstruction of a concurrent login window.

| Operation | Web SQL | Native SQL | Native - Web |
|---|---:|---:|---:|
| sign_in | 17 | 17 | +0 |
| get_session | 2 | 2 | +0 |
| bootstrap | 2 | 2 | +0 |
| session | 0 | 0 | +0 |
| workspace | 5 | 5 | +0 |
| bots | 4 | 2 | -2 |
| summaries | 5 | 5 | +0 |
| chat_first | 11 | 11 | +0 |
| chat_cursor | 7 | 7 | +0 |
| issues_first | 9 | 9 | +0 |
| issues_cursor | 7 | 7 | +0 |
| projects | 2 | 2 | +0 |
| thread_first | 6 | 6 | +0 |
| thread_cursor | 4 | 4 | +0 |
| teams | 2 | 2 | +0 |
| project_teams | 1 | 1 | +0 |
| model_menu | 24 | 24 | +0 |
| switcher | 4 | 2 | -2 |
| agent_sessions | 2 | 2 | +0 |
| computer_first | 4 | 4 | +0 |
| computer_cursor | 4 | 4 | +0 |
| preferences | 2 | 2 | +0 |
| enrollment | 3 | 3 | +0 |
| conversations | 5 | 5 | +0 |
| pending_actions | 1 | 1 | +0 |
| live_ticket | 3 | 3 | +0 |

| Additional diagnostic request | SQL |
|---|---:|
| pkce_begin | 1 |
| system_browser_config | 0 |
| system_browser_session | 0 |
| pkce_return | 2 |
| pkce_exchange | 8 |
| native_task_runs_first | 3 |
| native_task_runs_second | 3 |
| native_read_batch | 11 |

Same-argument task + cursor-thread + cursor-chat: separate 14; actual Native batch 11.

Native 186 > Web 162 remains the historical login budget failure. No request frequency, PKCE work or background work is removed from that budget.

The diagnostic passed 60 requests with one API PID and zero SQL/protocol-byte gaps. Driver-owned cleanup passed; the later exact GitHub job reports Stop containers success. The original runner pending receipt is preserved.
