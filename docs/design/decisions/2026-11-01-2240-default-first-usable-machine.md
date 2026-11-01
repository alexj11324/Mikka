# The machine picker defaults to the first usable machine

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 新建任务 picked Mikka Cloud
  by default with a green dot although a person without an E2B key has no
  cloud computer, so a new user's task went to a machine that does not exist
  and failed only after it was sent.
- Rule: R-23
- Replaces: the part of R-23 that made Mikka Cloud 「selected by default」

The order stays: Mikka Cloud, then 本机, then Remote control. The default is
the first machine that can run the task now. Mikka Cloud can run only with the
person's own E2B key
([2026-11-01-1200](2026-11-01-1200-own-e2b-key-is-enough-for-cloud.md)); a
device can run only while online. Without a key Mikka Cloud stays in the list,
greyed, marked 填入 E2B Key; picking it opens the key dialog, and once the key
is saved the task goes to the cloud. A green dot means online: Mikka Cloud is
green only while its computer runs, grey while asleep or without a key, red
when it failed. When nothing can run, the first machine stays selected and the
Coordinator reports the missing setup, as before.
