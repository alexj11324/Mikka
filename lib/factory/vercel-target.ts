// Shared Vercel publication identity. Kept free of server imports so the
// acceptance UI can build the same target the server adapter validates.
export const MIKKA_VERCEL = {
  teamId: "team_C7lwxVVvnUicFli6112mvxpv",
  projectId: "prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH",
  projectName: "mikka",
  repository: "https://github.com/alexj11324/Mikka.git",
  repoId: "1427517699",
} as const

export type PublicationEnvironment = "preview" | "production"

export const vercelTarget = (c: {
  teamId: string
  projectId: string
  environment: PublicationEnvironment
}) => `vercel:${c.teamId}:${c.projectId}:${c.environment}`

export const publicationActionFor = (environment: PublicationEnvironment) =>
  environment === "production" ? ("deploy_production" as const) : ("deploy_preview" as const)
