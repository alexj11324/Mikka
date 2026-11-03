"use client";

// Vendored from AI Elements: https://registry.ai-sdk.dev/message.json (fetched 2026-11-03), MessageActions and
// MessageAction only. Our message, bubble and Markdown are `components/ui/message.tsx`, `components/ui/bubble.tsx` and
// `AgentMarkdown`; MessageBranch is left out (a reply has no other versions to page through).
// Differs from upstream only in:
// - the tooltip uses base-ui's `render` prop instead of Radix's `asChild`, under the app's own TooltipProvider;
// - MessageAction's default size is `icon-xs` and its icon is muted until hover, as the actions under a Claude or
//   ChatGPT reply are; `label` is the button's accessible name (`aria-label`), not an sr-only span.

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div
    className={cn("flex items-center gap-1", className)}
    data-slot="message-actions"
    {...props}
  >
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-xs",
  className,
  onClick,
  ...props
}: MessageActionProps) => {
  const button = (
    <Button
      aria-label={label || tooltip}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={onClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    />
  );

  if (!tooltip) return <Button {...button.props} onClick={onClick}>{children}</Button>;

  return (
    <Tooltip>
      <TooltipTrigger render={button}>{children}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};
