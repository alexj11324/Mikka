import { PageEditor } from "./components/page-editor"

export function Page() {
  return (
    <div className="flex min-h-svh w-full flex-col">
      <PageEditor className="flex-1" />
    </div>
  )
}