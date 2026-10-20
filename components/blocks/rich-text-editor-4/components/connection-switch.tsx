import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface ConnectionSwitchProps {
  online: boolean
  onOnlineChange: (online: boolean) => void
  disabled?: boolean
}

/** The demo's network cable: off queues your edits, on merges them. */
export function ConnectionSwitch({
  online,
  onOnlineChange,
  disabled,
}: ConnectionSwitchProps) {
  return (
    <Label>
      <Switch
        size="sm"
        checked={online}
        disabled={disabled}
        onCheckedChange={onOnlineChange}
        aria-label="Online"
      />
      <span className="max-sm:sr-only">Online</span>
    </Label>
  )
}