'use client'

import { useMemo } from 'react'

export type TeamChoiceSource = { id: string; identifier: string; name: string }
export type TeamChoice = { value: string; label: string }

/** Stable item list for the Base UI team Select. A fresh array on each render retriggers its store. */
export function useTeamChoices(teams: readonly TeamChoiceSource[], noTeamLabel: string) {
  return useMemo<TeamChoice[]>(() => [
    { value: 'none', label: noTeamLabel },
    ...teams.map(team => ({ value: team.id, label: `${team.identifier} · ${team.name}` })),
  ], [teams, noTeamLabel])
}
