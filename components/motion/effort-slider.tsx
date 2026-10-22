"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { SPRING_LAYOUT, SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface EffortSliderProps {
  /** Levels lowest first, as the harness reports them. */
  levels: string[];
  /** The chosen level; null shows the track with no thumb (the CLI's own default). */
  value: string | null;
  onChange: (level: string) => void;
  formatLabel: (level: string) => string;
  /** Shown as the value while nothing is chosen. */
  placeholder: string;
  label?: string;
  lowLabel?: string;
  highLabel?: string;
}

/**
 * A stepped slider for reasoning effort: the track fills up to the chosen
 * step and a thumb springs between steps. Click a step, drag across the
 * track, or use the arrow keys; the level is committed when the pointer
 * is released, so a drag saves once.
 */
export function EffortSlider({ levels, value, onChange, formatLabel, placeholder, label = "Effort", lowLabel = "Faster", highLabel = "Smarter" }: EffortSliderProps) {
  const reduce = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const count = levels.length;
  const chosen = value ? levels.indexOf(value) : -1;
  const shown = dragging ?? chosen;
  const step = 100 / count;
  const spring = reduce ? { duration: 0 } : SPRING_LAYOUT;

  const indexAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || !rect.width) return shown;
    return Math.min(count - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * count)));
  };
  const commit = (index: number) => {
    if (index >= 0 && index !== chosen) onChange(levels[index]);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    setDragging(indexAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    const next = indexAt(event.clientX);
    if (next !== dragging) setDragging(next);
  };
  const onPointerUp = () => {
    if (dragging === null) return;
    commit(dragging);
    setDragging(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = chosen < 0 ? Math.floor((count - 1) / 2) : chosen;
    const next = { ArrowRight: from + 1, ArrowUp: from + 1, ArrowLeft: from - 1, ArrowDown: from - 1, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    commit(Math.min(count - 1, Math.max(0, chosen < 0 && event.key.startsWith("Arrow") ? from : next)));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-1.5 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="relative inline-flex overflow-hidden font-medium">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={shown < 0 ? "none" : levels[shown]}
              initial={reduce ? false : { y: "70%", opacity: 0, filter: "blur(2px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={reduce ? { opacity: 0 } : { y: "-70%", opacity: 0, filter: "blur(2px)" }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
            >
              {shown < 0 ? placeholder : formatLabel(levels[shown])}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={chosen < 0 ? undefined : chosen}
        aria-valuetext={chosen < 0 ? placeholder : formatLabel(levels[chosen])}
        data-dragging={dragging !== null || undefined}
        className="group/effort relative h-9 w-full cursor-pointer touch-none rounded-lg bg-inset outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragging(null)}
        onKeyDown={onKeyDown}
      >
        <motion.div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-lg bg-hover-2"
          initial={false}
          animate={{ width: shown < 0 ? "0%" : `${(shown + 1) * step}%`, opacity: shown < 0 ? 0 : 1 }}
          transition={spring}
        />
        <div aria-hidden="true" className="absolute inset-0 flex">
          {levels.map((level, index) => (
            <span key={level} className="flex flex-1 items-center justify-center">
              <span
                className={cn(
                  "h-4 w-0.75 rounded-full transition-colors duration-200",
                  index < shown ? "bg-ink-2" : "bg-border",
                  index === shown && "opacity-0",
                )}
              />
            </span>
          ))}
        </div>
        <motion.div
          aria-hidden="true"
          className="absolute inset-y-0.5 rounded-[calc(var(--radius-lg)-2px)] border bg-card shadow-sm group-data-dragging/effort:shadow-md dark:bg-accent"
          style={{ width: `calc(${step}% - 4px)` }}
          initial={false}
          animate={{ left: `calc(${Math.max(shown, 0) * step}% + 2px)`, opacity: shown < 0 ? 0 : 1, scale: dragging !== null && !reduce ? 0.96 : 1 }}
          transition={{ left: spring, opacity: { duration: reduce ? 0 : 0.15 }, scale: reduce ? { duration: 0 } : SPRING_PRESS }}
        />
      </div>
    </div>
  );
}
