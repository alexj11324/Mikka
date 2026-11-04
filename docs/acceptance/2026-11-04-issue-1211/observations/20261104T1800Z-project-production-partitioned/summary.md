## Fixed-hour egress collection: collected

Production acceptance: not established by this collector.

Reasons: none.

Role: observation.
UTC window (end exclusive): 2026-11-04T18:00:00.000Z → 2026-11-04T19:00:00.000Z.
Scope: all production deployments in the fixed Mikka project; no fixed-task comparison is established.

Vercel invocations: 4077; CPU ms: 471641.01096711936; HTTP 5xx: 10.
Invocation aggregation: count; provider status dimension: httpStatus.

| Deployment | Route template | HTTP status | Invocations | CPU ms |
| --- | --- | ---: | ---: | ---: |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /[locale] | 200 | 131 | 14270 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/version | 200 | 22 | 520 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/approved-writes | 200 | 19 | 800 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/conversations/[id]/read | 200 | 18 | 585 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/auth/[...all] | 200 | 13 | 1498.0000000000002 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/factory/tasks | 200 | 11 | 746.6666666666666 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/pending-actions | 200 | 10 | 10 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/agent/sessions | 200 | 9 | 810 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/conversations | 200 | 9 | 543.1666666666666 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/mobile/reactions | 200 | 9 | 0 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/workspace | 200 | 9 | 747.5 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/workspace/switcher | 200 | 9 | 182.5 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/live/ticket | 200 | 6 | 150 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/bots/[botId]/computer | 503 | 3 | 2366.6666666666665 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /[locale]/sign-in | 200 | 2 | 4550 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/cron/account-deletions | 200 | 2 | 4230 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/cron/audit-retention | 200 | 2 | 3080 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/cron/coordinator-wakes | 200 | 2 | 4970 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/cron/ops-monitor | 200 | 2 | 2310 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/cron/run-recovery | 200 | 2 | 3240 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/cron/schedules | 200 | 2 | 4580 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/webhooks/github | 202 | 2 | 440 |
| dpl_4RqUZM5Yb3Nk5Sx3Kqeb8KdHJ4Gb | /api/self-improvement | 200 | 1 | 50 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/version | 200 | 58 | 1300 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /[locale] | 200 | 16 | 5385 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/auth/[...all] | 200 | 5 | 960 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/cron/account-deletions | 200 | 5 | 6660 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/cron/audit-retention | 200 | 5 | 2890 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/cron/coordinator-wakes | 200 | 5 | 5630 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/cron/ops-monitor | 200 | 5 | 5150 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/cron/run-recovery | 200 | 5 | 7710 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/cron/schedules | 200 | 5 | 8190 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/webhooks/github | 202 | 5 | 1209.642857142857 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /v1/devices/[deviceId]/heartbeat | 200 | 4 | 0 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /v1/devices/[deviceId]/repos | 200 | 4 | 0 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /v1/devices/[deviceId]/commands | 200 | 3 | 169.5 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /v1/devices/[deviceId]/runs | 200 | 3 | 0 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /[locale]/sign-in | 200 | 2 | 4180 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/conversations | 200 | 2 | 102.5 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/webhooks/github | 204 | 2 | 90 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/agent/sessions | 200 | 1 | 1130 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/conversations/[id]/members | 200 | 1 | 1840 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/conversations/[id]/messages | 200 | 1 | 0 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/mobile/reactions | 200 | 1 | 0 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/workspace | 200 | 1 | 265 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /api/workspace/switcher | 200 | 1 | 0 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /v1/devices/[deviceId]/gateway | 200 | 1 | 0 |
| dpl_7xMAeC9jxMmtF4aajmSW5rYYaNjT | /v1/devices/register | 200 | 1 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /[locale] | 200 | 732 | 28632.888888888887 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/version | 200 | 115 | 760 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/approved-writes | 200 | 46 | 815.7727272727273 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/conversations/[id]/read | 200 | 38 | 1886.025641025641 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/conversations | 200 | 36 | 1517.1428571428573 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/auth/[...all] | 200 | 35 | 1146.8333333333335 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/factory/tasks | 200 | 25 | 3519.1666666666665 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/pending-actions | 200 | 23 | 1290.8823529411766 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/agent/sessions | 200 | 20 | 1027.7813852813852 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/workspace | 200 | 20 | 571.5 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/workspace/switcher | 200 | 20 | 105 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/mobile/reactions | 200 | 19 | 30 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/cron/account-deletions | 200 | 18 | 9350 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/cron/audit-retention | 200 | 18 | 6565 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/cron/coordinator-wakes | 200 | 18 | 15090 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/cron/ops-monitor | 200 | 18 | 8810 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/cron/run-recovery | 200 | 18 | 9780 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/cron/schedules | 200 | 18 | 8670 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/live/ticket | 200 | 14 | 210 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/webhooks/github | 202 | 14 | 2206.3333333333335 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/factory/tasks/[taskId] | 200 | 9 | 8980 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/factory/tasks/[taskId]/approval | 200 | 9 | 1654.1666666666665 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/bots/[botId]/computer | 503 | 7 | 272 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /v1/devices/[deviceId]/heartbeat | 200 | 7 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /v1/devices/[deviceId]/repos | 200 | 7 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /v1/devices/[deviceId]/commands | 200 | 6 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /v1/devices/[deviceId]/runs | 200 | 6 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /v1/devices/[deviceId]/gateway | 200 | 3 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /[locale]/sign-in | 200 | 2 | 4890 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/bots/[botId]/computer | 404 | 2 | 315 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/self-improvement | 200 | 2 | 25 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/settings/[read] | 200 | 2 | 740 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /v1/devices/register | 200 | 2 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/bots | 200 | 1 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/cron/briefings | 200 | 1 | 0 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/subscriptions | 200 | 1 | 165 |
| dpl_B4XZsPZ5VBR5tg1gayN6jNN6dJwP | /api/webhooks/github | 204 | 1 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/runs/[runId]/tool-approval | 200 | 290 | 440.2541849230423 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /[locale] | 200 | 196 | 19214.666666666664 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/version | 200 | 132 | 830 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/heartbeat | 200 | 124 | 464.3659842707996 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/repos | 200 | 124 | 646 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/runs | 200 | 124 | 226.09756097560975 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/approved-writes | 200 | 117 | 461.42857142857144 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/runs/[runId]/subscription | 200 | 107 | 2532.9925114445236 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/commands | 200 | 75 | 748.0539451948121 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/runs/[runId]/events | 200 | 63 | 43.75 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/pending-actions | 200 | 59 | 150 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/conversations/[id]/messages | 200 | 38 | 2175 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/runs/mcp/[toolkit] | 200 | 36 | 7173.333333333334 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/gateway | 401 | 25 | 90 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/cron/account-deletions | 200 | 23 | 14955 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/cron/audit-retention | 200 | 23 | 9115 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/cron/coordinator-wakes | 200 | 23 | 13136.42857142857 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/cron/ops-monitor | 200 | 23 | 8337 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/cron/run-recovery | 200 | 23 | 4374 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/cron/schedules | 200 | 23 | 15946.666666666666 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/factory/tasks/[taskId]/approval | 200 | 22 | 43.166666666666664 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/settings/[read] | 200 | 22 | 35464.58333333333 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /mikka/.well-known/workflow/v1/flow | 200 | 22 | 13979.5 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/bots/[botId]/computer | 200 | 21 | 190 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/factory/tasks | 200 | 20 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/webhooks/github | 202 | 20 | 97.77777777777777 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/conversations | 200 | 19 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/runs/[runId] | 204 | 18 | 36.83098591549296 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/runs/[runId]/claim | 409 | 13 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /[locale]/settings | 200 | 11 | 2808.3333333333335 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/mobile/reactions | 200 | 10 | 127.61904761904762 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/runs/[runId]/policy-snapshot | 200 | 10 | 31.379310344827587 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/workspace | 200 | 8 | 2423.8888888888887 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/auth/[...all] | 200 | 7 | 1844.9999999999998 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/conversations/[id]/read | 200 | 7 | 116.66666666666667 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/computer | 200 | 6 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/gateway | 200 | 6 | 50 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/register | 200 | 6 | 40.827586206896555 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/workspace/switcher | 200 | 5 | 1120 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/runs/[runId]/claim | 200 | 5 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/runs/[runId]/complete | 204 | 5 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/runs/[runId]/checkpoint | 204 | 4 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/agent/sessions | 200 | 3 | 180 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/computer/events | 200 | 3 | 2694.5 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/conversations/[id]/members | 200 | 3 | 100 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/teams/directory | 200 | 3 | 92.66666666666666 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/commands | 401 | 3 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/runs/[runId]/subscription | 409 | 3 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /[locale]/sign-in | 200 | 2 | 4560 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/coordinator/stream | 200 | 2 | 6190 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/factory/tasks/[taskId] | 200 | 2 | 2330 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/subscriptions | 200 | 2 | 120 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/subscriptions/usage | 200 | 2 | 3670 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/devices/[deviceId]/heartbeat | 401 | 2 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/bots/[botId] | 200 | 1 | 98.33333333333333 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/bots/[botId]/computer/viewer | 200 | 1 | 70 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/conversations/[id]/messages | 201 | 1 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/cron/briefings | 200 | 1 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/integrations/composio | 200 | 1 | 1400 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/mobile/bots/[id] | 200 | 1 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/self-improvement | 200 | 1 | 0 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /api/workspaces/[workspaceId]/computer-policy | 200 | 1 | 2070 |
| dpl_BKKMKTJtGFEPk4bDpE4QTGLnTCaZ | /v1/runs/[runId]/tool-approval | 409 | 1 | 0 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/version | 200 | 42 | 350 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /v1/devices/[deviceId]/heartbeat | 200 | 19 | 916.1304909560722 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /v1/devices/[deviceId]/repos | 200 | 19 | 0 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /v1/devices/[deviceId]/runs | 200 | 19 | 0 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/webhooks/github | 202 | 15 | 0 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /v1/devices/[deviceId]/commands | 200 | 10 | 280.6666666666667 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/auth/[...all] | 200 | 6 | 1146 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/account-deletions | 200 | 5 | 4670 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/audit-retention | 200 | 5 | 2080 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/coordinator-wakes | 200 | 5 | 4580 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/ops-monitor | 200 | 5 | 2655 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/run-recovery | 200 | 5 | 6280 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/schedules | 200 | 5 | 3290 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /[locale] | 200 | 4 | 6045 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/settings/[read] | 200 | 4 | 0 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /v1/devices/[deviceId]/gateway | 401 | 4 | 76.66666666666666 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/subscriptions | 200 | 3 | 1100 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /[locale]/sign-in | 200 | 2 | 3940 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/bots | 200 | 1 | 0 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/briefings | 200 | 1 | 2810 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /api/cron/user-facts | 200 | 1 | 850 |
| dpl_G64SurRdbYwX6H42AQBoxjUeRMrA | /mikka/.well-known/workflow/v1/flow | 200 | 1 | 6010 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/version | 200 | 29 | 140 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /[locale] | 200 | 18 | 1063.3333333333333 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /v1/devices/[deviceId]/heartbeat | 200 | 15 | 63.333333333333336 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /v1/devices/[deviceId]/repos | 200 | 15 | 0 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /v1/devices/[deviceId]/runs | 200 | 14 | 0 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /v1/devices/[deviceId]/commands | 200 | 13 | 172.52747252747253 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/account-deletions | 200 | 7 | 2186.666666666667 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/audit-retention | 200 | 7 | 1435 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/coordinator-wakes | 200 | 7 | 2880 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/ops-monitor | 200 | 7 | 1365 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/run-recovery | 200 | 7 | 1610 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/schedules | 200 | 7 | 1270 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/conversations | 200 | 6 | 323.0769230769231 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/conversations/[id]/messages | 200 | 6 | 0 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /v1/devices/[deviceId]/gateway | 200 | 6 | 41.111111111111114 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /v1/devices/register | 200 | 3 | 0 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/mobile/reactions | 200 | 2 | 0 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/conversations/[id]/messages | 201 | 1 | 463.75 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/briefings | 200 | 1 | 2720 |
| dpl_H7j3AfQRKPosNGitoCVSTG6K5FAM | /api/cron/suggestions-reconcile | 200 | 1 | 3250 |

Alias/build context changed during collection: false. This does not narrow the historical project scope.

Neon hour bytes: 60516203. Reported through: 2026-11-04T19:00:00.000Z.
Coverage: requested_hour_returned; scope: all branches in the fixed project.

- This is a project-wide production observation, never a fixed-task before, after or idle acceptance window.
- The completed hour can include multiple deployments, concurrent work and interrupted tasks; alias/build reads are collection context only.
- Vercel values are function-invocation observability aggregates, not an independent complete billing receipt.
- Neon project bytes include all branches; PostHog bucket alignment requires its own matching provider-hour evidence.
