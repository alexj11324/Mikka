# Factory runtime environment and accepted report state

- Date: 2026-11-03
- Source: Alex, reviewing the real #1118 acceptance UI: “环境那里为什么会写一个‘不可批准’呀？那个环境名字叫‘不可批准’吗？”
- Rule: —
- Replaces: using an approval-state fallback as the candidate environment label.

The environment row names the actual execution environment. `device:<id>` is a
device environment: use the supplied machine name when available, otherwise
“设备”; an explicitly identified cloud machine can read “云端”. Preview and
Production remain their actual environment labels. Other supplied environment
names remain readable; absent environment information does not acquire an
approval refusal label. These labels do not grant or change approval authority.

The same real UI exercise exposed a persisted accepted report still displaying
“待你确认” and an acceptance button. Accepted reports remain reachable in the
acceptance view, which reads the current candidate's persisted task state when
the existing detail request refreshes after acceptance.

Occurrence 10 × impact 4: every device candidate took the incorrect label path,
and an actual UI acceptance returned HTTP 200/accepted while the page continued
to show its pending action. Three focused regressions fail on the previous code.
