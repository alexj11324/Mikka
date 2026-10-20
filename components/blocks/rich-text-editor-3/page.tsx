import { ContractEditor } from "./components/contract-editor"

export function Page() {
  return (
    <div className="flex min-h-svh w-full flex-col">
      <ContractEditor className="flex-1" />
    </div>
  )
}