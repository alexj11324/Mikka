import { describe, expect, it } from "vitest"

import {
  CYCLE_CATCH_UP_MAX,
  addDays,
  cycleEnd,
  dateInTimeZone,
  endOfDayInTimeZone,
  isValidTimeZone,
  nextWeekdayOnOrAfter,
  planCycles,
  teamCycleSettings,
  teamCycleSettingsSchema,
  weekdayOf,
  type CycleWindow,
} from "./cycles"

const settings = (overrides: Record<string, unknown> = {}) =>
  teamCycleSettingsSchema.parse({ enabled: true, ...overrides })

const window = (
  number: number,
  startsAt: string,
  endsAt: string
): CycleWindow => ({ number, startsAt, endsAt })

describe("calendar arithmetic", () => {
  it("steps over a month end and a year end", () => {
    expect(addDays("2026-01-25", 14)).toBe("2026-02-08")
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    // A leap year keeps February's 29th.
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
  })

  it("counts weekdays from Monday", () => {
    expect(weekdayOf("2026-03-02")).toBe(0) // Monday
    expect(weekdayOf("2026-03-08")).toBe(6) // Sunday
  })

  it("returns the day itself when it already falls on the weekday", () => {
    expect(nextWeekdayOnOrAfter("2026-03-02", "monday")).toBe("2026-03-02")
    expect(nextWeekdayOnOrAfter("2026-03-03", "monday")).toBe("2026-03-09")
    expect(nextWeekdayOnOrAfter("2026-03-08", "monday")).toBe("2026-03-09")
  })

  it("ends a cycle on its last day, inclusively", () => {
    // 14 days from a Monday is the Sunday two weeks later, not three.
    expect(cycleEnd("2026-03-02", 14)).toBe("2026-03-15")
    expect(cycleEnd("2026-03-02", 1)).toBe("2026-03-02")
  })
})

describe("dateInTimeZone", () => {
  it("reads the team's day, not UTC's", () => {
    // 10:30 UTC on the 8th is already the 8th in Auckland (UTC+13, NZDT).
    expect(
      dateInTimeZone(new Date("2026-03-08T10:30:00Z"), "Pacific/Auckland")
    ).toBe("2026-03-08")
    expect(
      dateInTimeZone(new Date("2026-03-08T11:30:00Z"), "Pacific/Auckland")
    ).toBe("2026-03-09")
    // …while Los Angeles is still on the 7th at that moment (UTC-8, PST).
    expect(
      dateInTimeZone(new Date("2026-03-08T10:30:00Z"), "America/Los_Angeles")
    ).toBe("2026-03-08")
    expect(
      dateInTimeZone(new Date("2026-03-08T07:30:00Z"), "America/Los_Angeles")
    ).toBe("2026-03-07")
  })

  it("holds through the spring-forward switch", () => {
    // New York loses an hour at 02:00 on 2026-03-08 (EST -5 → EDT -4).
    expect(
      dateInTimeZone(new Date("2026-03-09T03:30:00Z"), "America/New_York")
    ).toBe("2026-03-08")
    expect(
      dateInTimeZone(new Date("2026-03-09T04:00:00Z"), "America/New_York")
    ).toBe("2026-03-09")
  })

  it("holds through the fall-back switch, where an hour repeats", () => {
    // 01:30 local happens twice on 2026-11-01; both are the same day.
    expect(
      dateInTimeZone(new Date("2026-11-01T05:30:00Z"), "America/New_York")
    ).toBe("2026-11-01")
    expect(
      dateInTimeZone(new Date("2026-11-01T06:30:00Z"), "America/New_York")
    ).toBe("2026-11-01")
    expect(
      dateInTimeZone(new Date("2026-11-02T04:30:00Z"), "America/New_York")
    ).toBe("2026-11-01")
  })

  it("finds the last millisecond of a day in the team's zone", () => {
    expect(endOfDayInTimeZone("2026-03-02", "UTC")).toBe(
      Date.parse("2026-03-02T23:59:59.999Z")
    )
    // New York is UTC-5 in March before the switch…
    expect(endOfDayInTimeZone("2026-03-02", "America/New_York")).toBe(
      Date.parse("2026-03-03T04:59:59.999Z")
    )
    // …and UTC-4 on and after it.
    expect(endOfDayInTimeZone("2026-03-08", "America/New_York")).toBe(
      Date.parse("2026-03-09T03:59:59.999Z")
    )
    // Auckland is UTC+13, so its day ends while UTC is still the day before.
    expect(endOfDayInTimeZone("2026-03-08", "Pacific/Auckland")).toBe(
      Date.parse("2026-03-08T10:59:59.999Z")
    )
    // The repeated hour on the way back does not move the boundary.
    expect(endOfDayInTimeZone("2026-11-01", "America/New_York")).toBe(
      Date.parse("2026-11-02T04:59:59.999Z")
    )
  })

  it("holds on the days a zone springs forward at local midnight", () => {
    // These zones have no local midnight on the day they change over: the
    // clock goes 23:59:59 → 01:00:00. Subtracting the offset in effect after
    // the jump would end the day an hour early, at 22:59 local.
    // Chile turns 2026-09-06 00:00 into 01:00 (UTC-4 → UTC-3).
    expect(endOfDayInTimeZone("2026-09-05", "America/Santiago")).toBe(
      Date.parse("2026-09-06T03:59:59.999Z")
    )
    // Cuba does the same on 2026-03-08 (UTC-5 → UTC-4).
    expect(endOfDayInTimeZone("2026-03-07", "America/Havana")).toBe(
      Date.parse("2026-03-08T04:59:59.999Z")
    )
    // The Azores are on UTC-1 and move to UTC+0 on 2026-03-29, so the 28th
    // ends while UTC is still on the 28th.
    expect(endOfDayInTimeZone("2026-03-28", "Atlantic/Azores")).toBe(
      Date.parse("2026-03-29T00:59:59.999Z")
    )
  })

  it("ends the day before a day the zone skips entirely", () => {
    // Samoa crossed the date line at the end of 2011-12-29: 2011-12-30 never
    // happened there. The 29th still ends where the 31st begins.
    const end = endOfDayInTimeZone("2011-12-29", "Pacific/Apia")
    expect(end).toBe(Date.parse("2011-12-30T09:59:59.999Z"))
    expect(dateInTimeZone(new Date(end + 1), "Pacific/Apia")).toBe("2011-12-31")
  })

  it("knows which zone names exist", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true)
    expect(isValidTimeZone("UTC")).toBe(true)
    expect(isValidTimeZone("Mars/Olympus")).toBe(false)
  })
})

describe("teamCycleSettings", () => {
  it("reads an absent row as cycles off, with usable rules behind it", () => {
    expect(teamCycleSettings(null)).toEqual({
      enabled: false,
      durationDays: 14,
      startWeekday: "monday",
      upcomingCount: 1,
      autoRollover: true,
      timezone: "UTC",
    })
  })

  it("falls back on a value it cannot use", () => {
    expect(
      teamCycleSettings({ durationDays: 0, timezone: "Mars/Olympus" })
    ).toMatchObject({ durationDays: 14, timezone: "UTC" })
  })

  it("keeps a valid row as written", () => {
    expect(
      teamCycleSettings({
        enabled: true,
        durationDays: 7,
        startWeekday: "thursday",
        upcomingCount: 3,
        autoRollover: false,
        timezone: "Europe/Berlin",
      })
    ).toEqual({
      enabled: true,
      durationDays: 7,
      startWeekday: "thursday",
      upcomingCount: 3,
      autoRollover: false,
      timezone: "Europe/Berlin",
    })
  })
})

describe("planCycles", () => {
  it("creates nothing while cycles are off", () => {
    expect(
      planCycles([], teamCycleSettingsSchema.parse({}), "2026-03-02")
    ).toEqual([])
  })

  it("starts a team's first cycle on its start weekday", () => {
    // Today is a Tuesday; the team starts cycles on Mondays.
    expect(
      planCycles([], settings({ upcomingCount: 0 }), "2026-03-03")
    ).toEqual([window(1, "2026-03-09", "2026-03-22")])
    // …and today counts when it already is that weekday.
    expect(
      planCycles([], settings({ upcomingCount: 0 }), "2026-03-02")
    ).toEqual([window(1, "2026-03-02", "2026-03-15")])
  })

  it("chains the successor of a cycle that has ended", () => {
    const existing = [window(1, "2026-03-02", "2026-03-15")]
    expect(
      planCycles(existing, settings({ upcomingCount: 0 }), "2026-03-16")
    ).toEqual([window(2, "2026-03-16", "2026-03-29")])
    // The last day is still the cycle's: nothing is created on the 15th.
    expect(
      planCycles(existing, settings({ upcomingCount: 0 }), "2026-03-15")
    ).toEqual([])
  })

  it("keeps the requested number of cycles that have not started", () => {
    const existing = [window(1, "2026-03-02", "2026-03-15")]
    expect(
      planCycles(existing, settings({ upcomingCount: 2 }), "2026-03-10")
    ).toEqual([
      window(2, "2026-03-16", "2026-03-29"),
      window(3, "2026-03-30", "2026-04-12"),
    ])
    // One is already planned ahead, so only one more is needed.
    expect(
      planCycles(
        [...existing, window(2, "2026-03-16", "2026-03-29")],
        settings({ upcomingCount: 2 }),
        "2026-03-10"
      )
    ).toEqual([window(3, "2026-03-30", "2026-04-12")])
  })

  it("catches a team up several cycles at once, without gaps", () => {
    const existing = [window(7, "2026-01-05", "2026-01-18")]
    const created = planCycles(
      existing,
      settings({ upcomingCount: 0 }),
      "2026-02-10"
    )
    expect(created).toEqual([
      window(8, "2026-01-19", "2026-02-01"),
      window(9, "2026-02-02", "2026-02-15"),
    ])
    // Every window begins the day after the one before it ends.
    for (let index = 1; index < created.length; index += 1) {
      expect(created[index]!.startsAt).toBe(
        addDays(created[index - 1]!.endsAt, 1)
      )
    }
  })

  it("is idempotent: planning again over what it made creates nothing", () => {
    const existing = [window(1, "2026-01-05", "2026-01-18")]
    const rules = settings({ upcomingCount: 2 })
    const created = planCycles(existing, rules, "2026-02-10")
    expect(created.length).toBeGreaterThan(0)
    expect(planCycles([...existing, ...created], rules, "2026-02-10")).toEqual(
      []
    )
  })

  it("numbers after the team's highest number, not its latest date", () => {
    // A cycle a person dated in January was handed number 3 by
    // `cycle.create`'s `max + 1`. Numbering the new window from the
    // latest-dated cycle would hand out 3 again and the insert would be
    // dropped as a number conflict on every pass, forever.
    const existing = [
      window(1, "2026-03-02", "2026-03-15"),
      window(2, "2026-03-16", "2026-03-29"),
      window(3, "2026-01-01", "2026-01-14"),
    ]
    expect(
      planCycles(existing, settings({ upcomingCount: 0 }), "2026-04-01")
    ).toEqual([window(4, "2026-03-30", "2026-04-12")])
    // …and the next pass sees the new window and stops.
    expect(
      planCycles(
        [...existing, window(4, "2026-03-30", "2026-04-12")],
        settings({ upcomingCount: 0 }),
        "2026-04-01"
      )
    ).toEqual([])
  })

  it("stops at the catch-up ceiling instead of filling a table", () => {
    const existing = [window(1, "2020-01-01", "2020-01-01")]
    const created = planCycles(
      existing,
      settings({ durationDays: 1, upcomingCount: 0 }),
      "2026-03-02"
    )
    expect(created).toHaveLength(CYCLE_CATCH_UP_MAX)
    expect(created.at(0)!.number).toBe(2)
  })
})

describe("a cycle's last minute in the team's zone", () => {
  const rules = settings({ upcomingCount: 0, timezone: "America/New_York" })
  const existing = [window(1, "2026-02-23", "2026-03-08")]

  it("rolls over at local midnight, not at UTC midnight", () => {
    // 23:59 on the 8th in New York is 03:59 UTC on the 9th: still the 8th.
    const before = new Date("2026-03-09T03:59:00Z")
    expect(dateInTimeZone(before, rules.timezone)).toBe("2026-03-08")
    expect(
      planCycles(existing, rules, dateInTimeZone(before, rules.timezone))
    ).toEqual([])

    // One minute later it is the 9th there, and the successor appears.
    const after = new Date("2026-03-09T04:00:00Z")
    expect(dateInTimeZone(after, rules.timezone)).toBe("2026-03-09")
    expect(
      planCycles(existing, rules, dateInTimeZone(after, rules.timezone))
    ).toEqual([window(2, "2026-03-09", "2026-03-22")])
  })

  it("crosses a month end on the team's calendar", () => {
    expect(planCycles(existing, rules, "2026-03-09")).toEqual([
      window(2, "2026-03-09", "2026-03-22"),
    ])
    expect(
      planCycles([window(1, "2026-03-16", "2026-03-29")], rules, "2026-03-30")
    ).toEqual([window(2, "2026-03-30", "2026-04-12")])
  })
})
