"use client";

// Vendored from AI Elements 1.9.1: https://registry.ai-sdk.dev/tool.json (fetched 2026-11-02).
// Differs from upstream only in:
// - the two `@ts-expect-error` lines for AI SDK v5 are removed (AI SDK 7 has those states);
// - copy comes from next-intl (`AiElements.tool`); labels are sentence case (R-32);
// - status icon colors use our tokens (success, destructive, warning-foreground, info-foreground);
// - open/closed selectors use base-ui's attributes (`data-open`, `data-closed`, `in-data-[panel-open]`) instead of Radix's `data-[state=…]`;
// - ToolInput shows a string input as it is instead of JSON.stringify'ing it (our previews may be cut JSON);
// - a chat line, not a card: no border, the header is one muted line like ReasoningTrigger (status icon, title,
//   chevron) with the state as its accessible text (visible only on error) instead of a Badge, and the open
//   parameters and result share one borderless muted panel with xs code, no nested code-block frame.

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import {
  ChevronDownIcon,
  CircleIcon,
  LoaderCircleIcon,
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
    className={cn("not-prose w-full min-w-0", className)}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"];
  className?: string;
  /** Nothing to open: no chevron, and the line does not toggle. */
  disabled?: boolean;
};

const getStatus = (status: ToolUIPart["state"], t: ReturnType<typeof useTranslations<"AiElements.tool">>) => {
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
    "input-streaming": <CircleIcon className="size-3.5" />,
    "input-available": <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />,
    "approval-requested": <CircleIcon className="size-3.5 text-warning-foreground" />,
    "approval-responded": <WrenchIcon className="size-3.5" />,
    "output-available": <WrenchIcon className="size-3.5" />,
    "output-error": <XCircleIcon className="size-3.5 text-destructive" />,
    "output-denied": <XCircleIcon className="size-3.5 text-warning-foreground" />,
  };

  const shown = status === "output-error" || status === "output-denied" || status === "approval-requested";
  return { icon: icons[status], label: labels[status], shown };
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  ...props
}: ToolHeaderProps) => {
  const t = useTranslations("AiElements.tool");
  const status = getStatus(state, t);
  return (
  <CollapsibleTrigger
    className={cn(
      "flex w-fit max-w-full items-center gap-2 text-muted-foreground text-xs transition-colors hover:text-foreground disabled:hover:text-muted-foreground [&:disabled>:last-child]:hidden",
      className
    )}
    {...props}
  >
    <span aria-hidden="true" className="flex shrink-0">{status.icon}</span>
    <span className="truncate">
      {title ?? type.split("-").slice(1).join("-")}
    </span>
    <span className={status.shown ? (state === "output-error" ? "text-destructive" : "text-warning-foreground") : "sr-only"}>
      {status.label}
    </span>
    <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 transition-transform in-data-[panel-open]:rotate-180" />
  </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, children, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-closed:fade-out-0 data-closed:slide-out-to-top-2 data-open:slide-in-from-top-2 text-popover-foreground outline-none data-closed:animate-out data-open:animate-in",
      className
    )}
    {...props}
  >
    {/* One panel for parameters and result; the padding sits inside, so the panel still opens from zero height. */}
    <div className="mt-1.5 flex flex-col gap-3 rounded-lg bg-muted/50 p-3">{children}</div>
  </CollapsibleContent>
);

/** Code inside the panel: no frame or background of its own, xs mono, no padding (beats CodeBlock's `[&>pre]` classes). */
const PLAIN_CODE = "rounded-none border-0 bg-transparent [&_div>pre]:bg-transparent! [&_div>pre]:p-0 [&_div>pre]:text-xs [&_pre>code]:text-xs";

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const t = useTranslations("AiElements.tool");
  return (
  <div className={cn("flex min-w-0 flex-col gap-1", className)} {...props}>
    <h4 className="text-muted-foreground text-xs">
      {t("parameters")}
    </h4>
    <CodeBlock className={PLAIN_CODE} code={typeof input === "string" ? input : JSON.stringify(input, null, 2)} language="json" />
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
      <CodeBlock className={PLAIN_CODE} code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock className={PLAIN_CODE} code={output} language="json" />;
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} {...props}>
      <h4 className="text-muted-foreground text-xs">
        {errorText ? t("error") : t("result")}
      </h4>
      <div
        className={cn(
          "overflow-x-auto font-mono text-xs [&_table]:w-full",
          errorText ? "whitespace-pre-wrap break-words text-destructive" : "text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
