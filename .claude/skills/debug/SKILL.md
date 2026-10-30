---
name: debug
description: Systematic debugging assistant. Always use this skill when investigating a bug, error, crash, unexpected behavior, or failing test, even for seemingly simple issues. Use when the user says "it's broken", "this doesn't work", "I'm getting a weird error", "why is this failing", "help me figure out why X happens", "I'm getting a TypeError/NullPointerException/500 error", or any time the root cause is unknown. Do not attempt to fix code without first reading this skill: frame the problem, form a hypothesis, and narrow scope before touching anything.
---

# Debug

Debugging is hypothesis-driven investigation, not random exploration. The goal is to find the root cause, not just a fix that makes the symptom disappear.

## Phase 1: Frame the problem

Before touching any code, establish:

1. **What is the expected behavior?** State it precisely.
2. **What is the actual behavior?** Include exact error messages, stack traces, or wrong outputs, not summaries.
3. **What changed recently?** A regression almost always has a cause. Ask if anything was deployed, upgraded, or modified before the symptom appeared.
4. **Is the problem reproducible?** If yes, under what conditions exactly? If intermittent, what's the pattern?

Don't skip this. Jumping to code before framing the problem wastes time and often leads to fixing the wrong thing.

## Phase 2: Form a hypothesis

State the most likely root cause as a falsifiable claim:

> "I think X is happening because Y."

A good hypothesis is specific enough that you can design a test to disprove it. If you can't think of such a test, the hypothesis is too vague. Narrow it down.

Start with the simplest explanation consistent with the evidence (Occam's razor). Common culprits, roughly in order of likelihood:

- Wrong assumption about input data or state
- Off-by-one, boundary condition, or null/undefined
- Race condition or ordering dependency
- Config or environment difference between working and broken context
- A dependency behaving differently than expected (version change, API contract)
- Logic error in a branch that's rarely exercised

## Phase 3: Narrow the scope

**For regressions**: Binary search the change history. Find the last known-good state, then bisect toward the first-bad commit. `git bisect` is your friend. This is almost always faster than reading code.

**For logic bugs**: Narrow the reproduction case to the smallest possible input that still shows the problem. Each reduction eliminates a whole class of suspects.

**For errors with stack traces**: Read the trace bottom-up (the innermost frame is where the problem actually is). Identify the first frame that's your own code, not library code; that's where to start reading.

**For wrong outputs**: Trace data through the system. Pick a concrete example and follow it from entry point to wrong output. The first place the value diverges from expectation is the bug site.

## Phase 4: Prove it before fixing it

Once you've identified a suspect, prove the hypothesis before writing any fix:

- Add a targeted log, assertion, or breakpoint at the suspect location
- Reproduce the bug deliberately with a minimal case
- Verify you can make it fail reliably, then make it pass reliably

If you can't reproduce the failure with your hypothesis in place, you have the wrong hypothesis. Go back to Phase 2.

## Phase 5: Fix at the root cause

Fix the underlying cause, not the symptom. Ask: "If I make this change and the root cause is still present, could the bug resurface in a different form?" If yes, you're treating a symptom.

Fixes should be:

- Minimal: change only what's needed to correct the behavior
- Targeted: don't refactor surrounding code while fixing a bug; that makes it harder to review and introduces risk

## Phase 6: Verify and prevent recurrence

After the fix:

1. Confirm the original reproduction case passes
2. Check for related cases the bug might have affected
3. Write a test that captures the failure mode: one that would have caught this bug before it shipped

The test is not optional. If the bug was real, the test proves it's fixed and guards against regression.

## When you're stuck

If you've been on the same hypothesis for more than ~20 minutes and it's not panning out:

- State your current model of the system out loud; often the error surfaces while explaining it (rubber duck)
- Ask: what assumption am I making that might be wrong?
- Try the opposite hypothesis: what if the problem is _not_ in the place I'm looking?
- Widen the scope: could this be environmental (different OS, different runtime version, different data)?

## What to communicate

When reporting progress:

- Say which hypothesis you're testing, not just "investigating"
- When you rule something out, say why; it helps the user understand the system too
- When you find the root cause, explain the causal chain clearly: what condition led to what behavior
