"use client";
import { useAgentCopy } from '@/hooks/use-agent-copy'
// beui.dev/components/agents/chat-app

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  LoaderCircle,
  MessageSquareText,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { statusTones } from "@/lib/status-appearance";
import { ActionSwapRollText } from "@/components/motion/action-swap-roll";
import { Button } from "@/components/motion/button";
import { Checkbox } from "@/components/motion/checkbox";
import { DateRangePickerDropdown } from "@/components/motion/date-range-picker";
import { RangeSlider } from "@/components/motion/range-slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/motion/select";
import { Switch } from "@/components/motion/switch";
import { Input } from "@/components/motion/input";
import { RadioGroup, RadioGroupItem } from "@/components/motion/radio";
import { EASE_OUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";
import type {
  ApprovalCardAnswer,
  ApprovalCardAnswers,
  ApprovalCardProps,
  ApprovalCardQuestion,
  ApprovalCardStatus,
} from "./types";

export type {
  ApprovalCardAnswer,
  ApprovalCardAnswers,
  ApprovalCardOption,
  ApprovalCardProps,
  ApprovalCardQuestion,
  ApprovalCardStatus,
} from "./types";

const EMPTY_ANSWER: ApprovalCardAnswer = { selected: [], custom: "" };

function useStatusLabel(status: ApprovalCardStatus) {
  const agentCopy = useAgentCopy()
  if (status === "submitting") return agentCopy.continuing;
  if (status === "approved") return agentCopy.approved;
  if (status === "rejected") return agentCopy.rejected;
  if (status === "changes-requested") return agentCopy.changesRequested;
  if (status === "answered") return agentCopy.feedbackProvided;
  return agentCopy.awaitingYourChoice;
}

function getStatusClass(status: ApprovalCardStatus) {
  if (status === "approved" || status === "answered") {
    return "text-success-foreground";
  }
  if (status === "rejected") return "text-destructive";
  if (status === "changes-requested") {
    return "text-warning-foreground";
  }
  return "text-muted-foreground";
}

function getStatusBadgeClass(status: ApprovalCardStatus) {
  if (status === "pending" || status === "changes-requested") {
    return statusTones.warning;
  }
  if (status === "submitting") {
    return statusTones.info;
  }
  if (status === "approved" || status === "answered") {
    return statusTones.success;
  }
  return statusTones.destructive;
}

function isAnswered(answer: ApprovalCardAnswer) {
  return answer.selected.length > 0 || Boolean(answer.custom?.trim());
}

function QuestionOptions({
  question,
  answer,
  disabled,
  onChange,
  onSingleSelect,
  dateRangePicker,
}: {
  question: ApprovalCardQuestion;
  answer: ApprovalCardAnswer;
  disabled: boolean;
  onChange: (answer: ApprovalCardAnswer) => void;
  onSingleSelect?: () => void;
  dateRangePicker?: ApprovalCardProps["dateRangePicker"];
}) {
  const agentCopy = useAgentCopy()

  const custom = answer.custom ?? "";

  return (
    <div className="mt-2">
      {question.input ? (
        <QuestionInput question={question} answer={answer} disabled={disabled} onChange={onChange} dateRangePicker={dateRangePicker} />
      ) : question.options?.length ? (
        question.multiple ? (
          <div className="grid gap-0.5">
            {question.options.map((option) => (
              <Checkbox
                key={option.value}
                checked={answer.selected.includes(option.value)}
                disabled={disabled || option.disabled}
                label={option.label}
                description={option.description}
                onCheckedChange={(checked) =>
                  onChange({
                    ...answer,
                    selected: checked
                      ? [...answer.selected, option.value]
                      : answer.selected.filter((value) => value !== option.value),
                  })
                }
                className="min-h-8 rounded-lg px-1.5 py-1"
              />
            ))}
          </div>
        ) : (
          <RadioGroup
            value={answer.selected[0] ?? ""}
            onValueChange={(value) => {
              onChange({ selected: [value], custom: "" });
              onSingleSelect?.();
            }}
            className="gap-0.5"
          >
            {question.options.map((option) => (
              <RadioGroupItem
                key={option.value}
                value={option.value}
                label={option.label}
                description={option.description}
                disabled={disabled || option.disabled}
                className="min-h-8 rounded-lg px-1.5 py-1"
              />
            ))}
          </RadioGroup>
        )
      ) : null}

      {question.allowCustom ? (
        <Input
          aria-label={((question.title) + agentCopy.AdditionalAnswer)}
          value={custom}
          disabled={disabled}
          placeholder={question.customPlaceholder ?? agentCopy.addAnotherAnswer}
          onChange={(value) =>
            onChange({
              selected: question.multiple ? answer.selected : [],
              custom: value,
            })
          }
          className={cn("p-0.5", question.options?.length && "mt-1.5")}
          classNames={{
            field:
              // R-31: a filled field, no stroke. --control darkens the grey card instead of a pale near-white patch.
              "h-10 rounded-lg border-0 bg-control hover:bg-control-hover data-[state=focused]:bg-control data-[state=focused]:ring-1 data-[state=focused]:ring-ring",
            input: "px-3 text-sm placeholder:text-muted-foreground",
          }}
        />
      ) : null}
    </div>
  );
}

const SELECT_ROOM = ["pb-14", "pb-24", "pb-34", "pb-44", "pb-54", "pb-64"];
const DATE_RANGE = /^(\d{4}-\d{2}-\d{2})(?: – (\d{4}-\d{2}-\d{2}))?$/;

/** Mikka: Select, Switch, RangeSlider and DateRangePicker answers, kept as the answer's custom text. */
function QuestionInput({
  question,
  answer,
  disabled,
  onChange,
  dateRangePicker,
}: {
  question: ApprovalCardQuestion;
  answer: ApprovalCardAnswer;
  disabled: boolean;
  onChange: (answer: ApprovalCardAnswer) => void;
  dateRangePicker?: ApprovalCardProps["dateRangePicker"];
}) {
  const agentCopy = useAgentCopy();
  const [selectOpen, setSelectOpen] = useState(false);
  const custom = answer.custom ?? "";
  const label = typeof question.title === "string" ? question.title : undefined;
  if (question.input === "select") {
    // The card clips its overflow, so make room under the field for the open panel.
    return (
      <div className={cn("transition-[padding] duration-200 motion-reduce:transition-none", selectOpen && SELECT_ROOM[Math.min(question.options?.length ?? 1, SELECT_ROOM.length) - 1])}>
      <Select value={answer.selected[0] ?? ""} onValueChange={(value) => onChange({ selected: [value], custom: "" })} onOpenChange={setSelectOpen} disabled={disabled} className="w-full">
        <SelectTrigger><SelectValue placeholder={agentCopy.chooseOption} /></SelectTrigger>
        <SelectContent>
          {question.options?.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      </div>
    );
  }
  if (question.input === "switch") {
    return (
      <Switch
        checked={custom === agentCopy.answerYes}
        onCheckedChange={(checked) => onChange({ selected: [], custom: checked ? agentCopy.answerYes : agentCopy.answerNo })}
        disabled={disabled}
        label={custom === agentCopy.answerYes ? agentCopy.answerYes : agentCopy.answerNo}
        ariaLabel={label}
      />
    );
  }
  if (question.input === "slider" && question.range) {
    const { min, max, step = 1, unit = "" } = question.range;
    const parsed = Number.parseFloat(custom);
    const value = Number.isFinite(parsed) ? parsed : min;
    return (
      <div className="flex items-center gap-3">
        <RangeSlider
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={label}
          formatValueText={(next) => `${next}${unit}`}
          onValueChange={(next) => onChange({ selected: [], custom: `${next}${unit}` })}
          showTicks={(max - min) / step <= 20}
          className="min-w-0 flex-1"
        />
        <span className="w-16 shrink-0 text-right text-sm tabular-nums">{value}{unit}</span>
      </div>
    );
  }
  if (question.input === "dateRange") {
    const match = DATE_RANGE.exec(custom);
    return (
      <DateRangePickerDropdown
        {...dateRangePicker}
        value={match ? { from: match[1], to: match[2] ?? match[1] } : null}
        onValueChange={(range) => onChange({ selected: [], custom: range ? `${range.from} – ${range.to ?? range.from}` : "" })}
        disabled={disabled}
        label={label}
        placeholder={agentCopy.chooseDateRange}
        closeOnSelect
      />
    );
  }
  return null;
}

function ProgressDots({ current, ids }: { current: number; ids: string[] }) {
  const agentCopy = useAgentCopy()

  return (
    <span className="flex gap-1.5">
      <span className="sr-only">
        {agentCopy.question}{current + 1} {agentCopy.of}{ids.length} {agentCopy.questions}</span>
      {ids.map((id, index) => (
        <motion.span
          key={id}
          aria-hidden="true"
          initial={{
            scale: index === current ? 1 : 0.75,
            opacity: index <= current ? 1 : 0.35,
          }}
          animate={{
            scale: index === current ? 1 : 0.75,
            opacity: index <= current ? 1 : 0.35,
          }}
          transition={SPRING_SWAP}
          className="size-1.5 rounded-full bg-foreground"
        />
      ))}
    </span>
  );
}

export function ApprovalCard({
  title: titleProp,
  description,
  children,
  questions = [],
  status = "pending",
  answers,
  defaultAnswers = {},
  onAnswersChange,
  step,
  defaultStep = 0,
  onStepChange,
  onSubmit,
  onApprove,
  onReject,
  onRequestChanges,
  onDismiss,
  approveLabel: approveLabelProp,
  submitLabel: submitLabelProp,
  result,
  dateRangePicker,
  className,
}: ApprovalCardProps) {
  const agentCopy = useAgentCopy()
const title = titleProp ?? agentCopy.reviewThisProposal
const approveLabel = approveLabelProp ?? agentCopy.approve
const submitLabel = submitLabelProp ?? agentCopy.answer


  const reduce = useReducedMotion() ?? false;
  const [internalAnswers, setInternalAnswers] =
    useState<ApprovalCardAnswers>(defaultAnswers);
  const [internalStep, setInternalStep] = useState(defaultStep);
  const autoAdvanceTimer = useRef<number | undefined>(undefined);
  const currentAnswers = answers ?? internalAnswers;
  const currentStep = Math.min(
    Math.max(0, step ?? internalStep),
    Math.max(0, questions.length - 1),
  );
  const question = questions[currentStep];
  const questionMode = questions.length > 0;
  const multipleQuestions = questions.length > 1;
  const pending = status === "pending";
  const busy = status === "submitting";
  const interactive = pending || busy;
  const currentAnswer = question
    ? (currentAnswers[question.id] ?? EMPTY_ANSWER)
    : EMPTY_ANSWER;
  const displayTitle = question?.title ?? title;
  const titleKey = question?.id ?? "approval";
  const statusLabel = useStatusLabel(status);

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimer.current === undefined) return;
    window.clearTimeout(autoAdvanceTimer.current);
    autoAdvanceTimer.current = undefined;
  }, []);

  useEffect(() => clearAutoAdvance, [clearAutoAdvance]);

  const setAnswers = useCallback(
    (next: ApprovalCardAnswers) => {
      if (answers === undefined) setInternalAnswers(next);
      onAnswersChange?.(next);
    },
    [answers, onAnswersChange],
  );

  const setStep = (next: number) => {
    clearAutoAdvance();
    if (step === undefined) setInternalStep(next);
    onStepChange?.(next);
  };

  const updateCurrentAnswer = (next: ApprovalCardAnswer) => {
    if (!question) return;
    setAnswers({ ...currentAnswers, [question.id]: next });
  };

  const continueQuestion = () => {
    if (currentStep < questions.length - 1) {
      setStep(currentStep + 1);
      return;
    }
    onSubmit?.(currentAnswers);
  };

  const queueAutoAdvance = () => {
    if (
      !question ||
      question.multiple ||
      question.autoAdvance === false ||
      currentStep >= questions.length - 1 ||
      busy
    ) {
      return;
    }

    clearAutoAdvance();
    autoAdvanceTimer.current = window.setTimeout(() => {
      setStep(currentStep + 1);
    }, 240);
  };

  return (
    <div
      data-state={status}
      aria-busy={busy}
      className={cn(
        "w-full overflow-hidden rounded-2xl bg-muted p-3 text-sm",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-5 shrink-0 place-items-center text-muted-foreground",
            getStatusClass(status),
          )}
        >
          {busy ? (
            <LoaderCircle className={cn("size-4", !reduce && "animate-spin")} />
          ) : interactive ? (
            questionMode ? (
              <CircleHelp className="size-4" />
            ) : (
              <MessageSquareText className="size-4" />
            )
          ) : status === "rejected" ? (
            <X className="size-4" />
          ) : (
            <Check className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-3">
            <h3 className="min-w-0 flex-1 text-base font-medium leading-5 text-foreground">
              <ActionSwapRollText value={titleKey}>
                {displayTitle}
              </ActionSwapRollText>
            </h3>
            {/* The dots by 上一题 / 下一题 already show the step (and say it to a screen reader); no 「1/4」 here too (R-40). */}
            {questionMode && interactive ? null : (
              <span
                className={cn(
                  "shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
                  getStatusBadgeClass(status),
                )}
              >
                {statusLabel}
              </span>
            )}
            {onDismiss ? (
              <Button variant="ghost" size="sm"
                type="button"
                aria-label={agentCopy.close}
                onClick={onDismiss}
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>

          <AgentDisclosure open={interactive}>
            {questionMode && question ? (
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  key={question.id}
                  initial={reduce ? { opacity: 1 } : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
                  transition={{ duration: reduce ? 0 : 0.2, ease: EASE_OUT }}
                >
                  {question.description ? (
                    <p className="mt-1 leading-5 text-muted-foreground">
                      {question.description}
                    </p>
                  ) : null}
                  <QuestionOptions
                    question={question}
                    answer={currentAnswer}
                    disabled={busy}
                    onChange={updateCurrentAnswer}
                    onSingleSelect={queueAutoAdvance}
                    dateRangePicker={dateRangePicker}
                  />
                </motion.div>
              </AnimatePresence>
            ) : (
              <div>
                {description ? (
                  <div className="mt-1 leading-5 text-muted-foreground">
                    {description}
                  </div>
                ) : null}
                {children ? <div className="mt-3">{children}</div> : null}
              </div>
            )}

            {questionMode ? (
              // Back, progress and next sit together on the right, within one thumb's reach (Codex, Linear).
              <div className="mt-3 flex items-center justify-end gap-2">
                {multipleQuestions ? (
                  <>
                    <ProgressDots
                      current={currentStep}
                      ids={questions.map((item) => item.id)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={agentCopy.previousQuestion}
                      disabled={busy || currentStep === 0}
                      onClick={() => setStep(currentStep - 1)}
                      className="rounded-full"
                    >
                      <ArrowLeft className="size-4" />
                    </Button>
                  </>
                ) : null}
                <Button
                  size={currentStep === questions.length - 1 ? "sm" : "icon"}
                  aria-label={
                    currentStep === questions.length - 1
                      ? typeof submitLabel === "string" ? submitLabel : agentCopy.answer
                      : agentCopy.nextQuestion
                  }
                  disabled={busy || !isAnswered(currentAnswer) || (currentStep === questions.length - 1 && questions.some(item => !isAnswered(currentAnswers[item.id] ?? EMPTY_ANSWER)))}
                  onClick={continueQuestion}
                  className="rounded-full disabled:bg-control disabled:text-muted-foreground disabled:opacity-100"
                >
                  {busy ? (
                    <LoaderCircle className={cn("size-4", !reduce && "animate-spin")} />
                  ) : currentStep === questions.length - 1 ? (
                    <>
                      {submitLabel}
                      <ArrowRight className="size-3.5" />
                    </>
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                </Button>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={onApprove}
                  className="rounded-full"
                >
                  {approveLabel}
                </Button>
                {onRequestChanges ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={onRequestChanges}
                    className="rounded-full"
                  >
                    {agentCopy.requestChanges}</Button>
                ) : null}
                {onReject ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={onReject}
                    className="rounded-full text-muted-foreground hover:text-destructive"
                  >
                    {agentCopy.reject}</Button>
                ) : null}
              </div>
            )}
          </AgentDisclosure>

          {!interactive ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {result ?? statusLabel}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
