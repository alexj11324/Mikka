"use client";

// Vendored from AI Elements 1.9.1: https://registry.ai-sdk.dev/tool.json (fetched 2026-11-02).
// Differs from upstream only in:
// - the two `@ts-expect-error` lines for AI SDK v5 are removed (AI SDK 7 has those states);
// - copy comes from next-intl (`AiElements.tool`); labels are sentence case (R-32);
// - status icon colors use our tokens (success, destructive, warning-foreground, info-foreground);
// - open/closed selectors use base-ui's attributes (`data-open`, `data-closed`, `in-data-[panel-open]`) instead of Radix's `data-[state=…]`;
// - ToolInput shows a string input as it is instead of JSON.stringify'ing it (our previews may be cut JSON).

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { isValidElement } from "react";
import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"];
  className?: string;
};

const getStatusBadge = (status: ToolUIPart["state"], t: ReturnType<typeof useTranslations<"AiElements.tool">>) => {
  const labels: Record<ToolUIPart["state"], string> = {
    "input-streaming": t("pending"),
    "input-available": t("running"),
    "approval-requested": t("awaitingApproval"),
    "approval-responded": t("responded"),
    "output-available": t("completed"),
    "output-error": t("error"),
    "output-denied": t("denied"),
  };

  const icons: Record<ToolUIPart["state"], ReactNode> = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "approval-requested": <ClockIcon className="size-4 text-warning-foreground" />,
    "approval-responded": <CheckCircleIcon className="size-4 text-info-foreground" />,
    "output-available": <CheckCircleIcon className="size-4 text-success" />,
    "output-error": <XCircleIcon className="size-4 text-destructive" />,
    "output-denied": <XCircleIcon className="size-4 text-warning-foreground" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  ...props
}: ToolHeaderProps) => {
  const t = useTranslations("AiElements.tool");
  return (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4 p-3",
      className
    )}
    {...props}
  >
    <div className="flex items-center gap-2">
      <WrenchIcon className="size-4 text-muted-foreground" />
      <span className="font-medium text-sm">
        {title ?? type.split("-").slice(1).join("-")}
      </span>
      {getStatusBadge(state, t)}
    </div>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform in-data-[panel-open]:rotate-180" />
  </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-closed:fade-out-0 data-closed:slide-out-to-top-2 data-open:slide-in-from-top-2 text-popover-foreground outline-none data-closed:animate-out data-open:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const t = useTranslations("AiElements.tool");
  return (
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs">
      {t("parameters")}
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={typeof input === "string" ? input : JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  const t = useTranslations("AiElements.tool");
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs">
        {errorText ? t("error") : t("result")}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
