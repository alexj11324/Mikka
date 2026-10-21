// The permission matrix of ADR 0047, cell by cell. The expected table below
// is written out by hand on purpose: adding a capability or a role without
// deciding what it means for every role fails this test rather than silently
// defaulting to "no".
import { describe, expect, it } from "vitest"

import {
  EVERY_TEAM_ROLES,
  ROLE_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_ROLES,
  roleMay,
  roleMayAdminister,
  roleMayManageTeams,
  roleMayRead,
  roleMayShare,
  roleMaySteer,
  roleMayWrite,
  roleSeesEveryTeam,
  rowIsVisibleTo,
  type WorkspaceCapability,
  type WorkspaceRole,
} from "./roles"

/** The matrix as ADR 0047 documents it: role -> the capabilities it has. */
const DOCUMENTED: Record<WorkspaceRole, readonly WorkspaceCapability[]> = {
  owner: ["read", "write", "administer", "manageTeams", "share", "steer"],
  admin: ["read", "write", "administer", "manageTeams", "share", "steer"],
  member: ["read", "write", "share", "steer"],
  guest: ["read"],
}

describe("the permission matrix (ADR 0047)", () => {
  it("covers every role of the workspace", () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual(
      [...WORKSPACE_ROLES].sort()
    )
  })

  it("matches the documented matrix in every cell", () => {
    for (const role of WORKSPACE_ROLES) {
      for (const capability of WORKSPACE_CAPABILITIES) {
        const expected = DOCUMENTED[role].includes(capability)
        expect(roleMay(role, capability), `${role} / ${capability}`).toBe(
          expected
        )
      }
    }
  })

  it("answers each named predicate from the same table", () => {
    for (const role of WORKSPACE_ROLES) {
      expect(roleMayRead(role)).toBe(DOCUMENTED[role].includes("read"))
      expect(roleMayWrite(role)).toBe(DOCUMENTED[role].includes("write"))
      expect(roleMayAdminister(role)).toBe(
        DOCUMENTED[role].includes("administer")
      )
      expect(roleMayManageTeams(role)).toBe(
        DOCUMENTED[role].includes("manageTeams")
      )
      expect(roleMayShare(role)).toBe(DOCUMENTED[role].includes("share"))
      expect(roleMaySteer(role)).toBe(DOCUMENTED[role].includes("steer"))
    }
  })

  it("fails closed for a role the database should never hand out", () => {
    for (const capability of WORKSPACE_CAPABILITIES) {
      expect(roleMay("superuser", capability)).toBe(false)
      expect(roleMay("", capability)).toBe(false)
    }
  })

  it("gives a guest read and nothing else", () => {
    expect(WORKSPACE_CAPABILITIES.filter((c) => roleMay("guest", c))).toEqual([
      "read",
    ])
  })

  it("keeps the team-wide roles derived from the matrix", () => {
    expect([...EVERY_TEAM_ROLES]).toEqual(["owner", "admin"])
    for (const role of WORKSPACE_ROLES) {
      expect(roleSeesEveryTeam(role)).toBe(roleMayAdminister(role))
    }
  })
})

describe("row visibility in a team (ADR 0047)", () => {
  it("shows a public team's rows to everyone in the workspace", () => {
    for (const role of WORKSPACE_ROLES) {
      for (const onTeam of [true, false]) {
        expect(rowIsVisibleTo({ isPrivate: false }, { role, onTeam })).toBe(
          true
        )
      }
    }
  })

  it("shows a private team's rows to its members, whatever their role", () => {
    for (const role of WORKSPACE_ROLES) {
      expect(rowIsVisibleTo({ isPrivate: true }, { role, onTeam: true })).toBe(
        true
      )
    }
  })

  it("hides a private team's rows from members and guests who are not on it", () => {
    for (const role of ["member", "guest"]) {
      expect(rowIsVisibleTo({ isPrivate: true }, { role, onTeam: false })).toBe(
        false
      )
    }
  })

  it("keeps a private team's rows visible to owners and admins", () => {
    for (const role of ["owner", "admin"]) {
      expect(rowIsVisibleTo({ isPrivate: true }, { role, onTeam: false })).toBe(
        true
      )
    }
  })

  it("treats a row with no team as workspace-wide", () => {
    for (const role of WORKSPACE_ROLES) {
      expect(rowIsVisibleTo(null, { role, onTeam: false })).toBe(true)
      expect(rowIsVisibleTo(undefined, { role, onTeam: false })).toBe(true)
    }
  })
})
