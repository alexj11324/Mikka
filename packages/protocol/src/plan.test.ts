import { describe, expect, it } from "vitest"

import {
  planHandoff,
  planPriorityValue,
  planSplitProblem,
  specDoc,
  type PlanSplit,
} from "./plan"

const issue = (over: Partial<PlanSplit["issues"][number]> = {}) => ({
  key: "a",
  title: "Scaffold",
  blockedBy: [],
  criteria: [{ body: "The schema exists." }],
  predictedFiles: [],
  priority: "none" as const,
  ...over,
})

const split = (issues: PlanSplit["issues"]): PlanSplit => ({
  summary: "",
  issues,
})

describe("planSplitProblem", () => {
  it("accepts a sound plan", () => {
    expect(
      planSplitProblem(
        split([
          issue({ key: "scaffold" }),
          issue({ key: "api", blockedBy: ["scaffold"], parentKey: "scaffold" }),
        ])
      )
    ).toBeNull()
  })

  it("refuses duplicate keys", () => {
    expect(planSplitProblem(split([issue(), issue()]))).toContain(
      "share the key"
    )
  })

  it("refuses unknown parents and blockers", () => {
    expect(planSplitProblem(split([issue({ parentKey: "nope" })]))).toContain(
      "unknown parent"
    )
    expect(planSplitProblem(split([issue({ blockedBy: ["nope"] })]))).toContain(
      "unknown issue"
    )
  })

  it("refuses a self-parent and a self-blocker", () => {
    expect(planSplitProblem(split([issue({ parentKey: "a" })]))).toContain(
      "its own parent"
    )
    expect(planSplitProblem(split([issue({ blockedBy: ["a"] })]))).toContain(
      "blocked by itself"
    )
  })

  it("refuses a cycle across parents and blockers", () => {
    const problem = planSplitProblem(
      split([
        issue({ key: "a", parentKey: "b" }),
        issue({ key: "b", blockedBy: ["a"] }),
      ])
    )
    expect(problem).toContain("cycle")
  })
})

describe("planHandoff", () => {
  it("takes a spec and its split, with the daemon's spec id", () => {
    const parsed = planHandoff.safeParse({
      specId: "5b0f0f4a-1c2b-4a5f-8f2a-2b0a0f0f0f0f",
      spec: {
        title: "Planner",
        sections: [{ heading: "Goals", items: ["a"] }],
      },
      split: { issues: [issue()] },
    })
    expect(parsed.success).toBe(true)
    // The optional fields the agent may leave out come back filled in.
    expect(parsed.data?.spec.summary).toBe("")
    expect(parsed.data?.split.issues[0]?.blockedBy).toEqual([])
  })

  it("refuses an issue with no acceptance criterion", () => {
    const parsed = planHandoff.safeParse({
      specId: "5b0f0f4a-1c2b-4a5f-8f2a-2b0a0f0f0f0f",
      spec: {
        title: "Planner",
        sections: [{ heading: "Goals", items: ["a"] }],
      },
      split: { issues: [issue({ criteria: [] })] },
    })
    expect(parsed.success).toBe(false)
  })

  it("refuses a spec id that is not a uuid", () => {
    const parsed = planHandoff.safeParse({
      specId: "spec-1",
      spec: {
        title: "Planner",
        sections: [{ heading: "Goals", items: ["a"] }],
      },
      split: { issues: [issue()] },
    })
    expect(parsed.success).toBe(false)
  })
})

describe("specDoc", () => {
  it("puts the summary first, then a heading and its bullets per section", () => {
    const doc = specDoc({
      title: "Planner",
      summary: "What changes.",
      sections: [{ heading: "Goals", items: ["one", "two"] }],
    })
    expect(doc.type).toBe("doc")
    expect(doc.content).toHaveLength(3)
    expect(doc.content[1]).toMatchObject({
      type: "heading",
      content: [{ text: "Goals" }],
    })
    expect(doc.content[2]).toMatchObject({ type: "bulletList" })
  })
})

describe("planPriorityValue", () => {
  it("stores the sidebar's own order", () => {
    expect(planPriorityValue("none")).toBe(0)
    expect(planPriorityValue("urgent")).toBe(1)
    expect(planPriorityValue("low")).toBe(4)
  })
})
