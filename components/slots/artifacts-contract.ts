// What the artifacts slot receives (docs/ui-overlay.md): the Artifact page's body.
// The artifacts themselves come from listArtifacts (app/actions/artifacts.ts);
// the tasks name the folders a layer may group them into.
export type ArtifactsPageProps = {
  /** The workspace's tasks, to name the task each artifact was made for. */
  issues: { id: string; title: string; identifier: string | null }[]
}
