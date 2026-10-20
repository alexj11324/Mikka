import { LiveSpecEditor } from "./components/live-spec-editor"

export function Page() {
  return (
    <div className="flex min-h-svh w-full flex-col">
      <LiveSpecEditor className="flex-1" />
    </div>
  )
}