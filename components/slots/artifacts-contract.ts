// What the artifacts slot receives (docs/ui-overlay.md): the Artifact page's body.
// The artifacts themselves come from listArtifacts (app/actions/artifacts.ts);
// the tasks name the folders a layer may group them into.
export type ArtifactsPageProps = {
  /** Explicit tenant and account for private file reads and client cache keys. */
  workspaceId?: string
  ownerId?: string
  /** The workspace's tasks, to name the task each artifact was made for. */
  issues: { id: string; workspaceId: string | null; title: string; identifier: string | null }[]
}
