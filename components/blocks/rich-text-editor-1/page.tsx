import { RichTextEditor } from "./components/rich-text-editor"

export function Page() {
  return (
    <div className="flex h-svh w-full flex-col p-4">
      <RichTextEditor className="flex-1" />
    </div>
  )
}