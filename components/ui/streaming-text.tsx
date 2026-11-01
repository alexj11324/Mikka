"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";

/* ──────────────────────────────────
 * STREAMING TEXT
 * Words resolve out of blur, inline citations appear in
 * context, then actions and follow-up prompts become usable.
 *
 * Mikka changes to the stock component: the keyframes come from
 * tw-animate-css (pop-in = zoom-in-95, fade-up = slide-in-from-bottom-2)
 * because app CSS may not define its own, and the chip and the sources
 * list are exported so real replies can use them.
 * ────────────────────────────────── */

const WORD_MS = 80;
const HOLD_MS = 3400;

type Token = { text: string; cite?: boolean };

const TOKENS: Token[] = [
  ..."Pistachio is your fastest-growing flavor — sales are up 23% this month and margins beat vanilla by 8 points."
    .split(" ")
    .map((text) => ({ text })),
  { text: "", cite: true },
  ..."Stone-fruit flavors are trending in the same range."
    .split(" ")
    .map((text) => ({ text })),
];

const FOLLOW_UPS = [
  "Which flavors sell best in winter",
  "Compare gelato and soft serve margins",
];

const SOURCE_IMAGES = {
  scoop:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%231f7a5f'/%3E%3Cpath d='M20 36c0 7 5.4 12 12 12s12-5 12-12H20Z' fill='%23fff'/%3E%3Ccircle cx='32' cy='25' r='11' fill='%23bff3dd'/%3E%3Cpath d='M24 24c4-7 13-7 17 0' fill='none' stroke='%231f7a5f' stroke-width='4' stroke-linecap='round'/%3E%3C/svg%3E",
  trends:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%232f6fec'/%3E%3Cpath d='M15 43 27 31l8 7 14-18' fill='none' stroke='%23fff' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='49' cy='20' r='5' fill='%23bfe0ff'/%3E%3C/svg%3E",
  market:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23e56d24'/%3E%3Cpath d='M17 45V25h8v20h-8Zm11 0V16h8v29h-8Zm11 0V30h8v15h-8Z' fill='%23fff'/%3E%3Cpath d='M16 49h32' stroke='%23ffd6b8' stroke-width='4' stroke-linecap='round'/%3E%3C/svg%3E",
};

/** One cited source. `icon` stands in for `image` when the source has a drawn mark instead of a picture. */
export type StreamingSource = {
  name: string;
  domain: string;
  href?: string;
  image?: string | null;
  icon?: React.ReactNode;
  onSelect?: () => void;
};

const SOURCES: StreamingSource[] = [
  { name: "Scoop Data", domain: "scoopdata.io", href: "https://scoopdata.io/", image: SOURCE_IMAGES.scoop },
  { name: "Trends Index", domain: "trends.google.com", href: "https://trends.google.com/trends/", image: SOURCE_IMAGES.trends },
  { name: "Market Basket", domain: "marketbasket.io", href: "https://marketbasket.io/", image: SOURCE_IMAGES.market },
];

/** The source's picture, or its drawn mark in a box of the same size. */
export function SourceAvatar({ source, className }: { source: StreamingSource; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (source.image && failed !== source.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- source favicons from any host
      <img
        src={source.image}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(source.image ?? null)}
        className={cn("source-avatar size-3 shrink-0 rounded-[3px] object-contain", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn("source-avatar inline-flex size-3 shrink-0 items-center justify-center rounded-[3px] text-ink [&_svg]:size-full", className)}
    >
      {source.icon}
    </span>
  );
}

/** The inline chip's look, shared with chips that render through another trigger (a hover card): an icon, then the name as plain text in the surrounding font, with no box around the whole. */
export const sourceChipClassName =
  "mx-0.5 inline-flex max-w-64 translate-y-[-1px] cursor-pointer items-center gap-1.5 align-middle text-current underline decoration-current/30 underline-offset-[3px] outline-none transition-[text-decoration-color] duration-150 hover:decoration-current focus-visible:rounded-[4px] focus-visible:ring-2 focus-visible:ring-ring data-popup-open:decoration-current animate-in fade-in-0 animation-duration-250 ease-[cubic-bezier(0.23,1,0.32,1)] fill-mode-both";

/** A Mikka object named in text (task, thread): a boxed chip with a faint accent fill and the title in the accent; it never breaks across lines (R-15). */
export const objectChipClassName =
  "mx-0.5 inline-flex h-5 max-w-72 translate-y-[-1px] cursor-pointer items-center gap-1 whitespace-nowrap rounded-[5px] bg-object-chip px-1.5 align-middle text-object-chip-foreground no-underline outline-none transition-colors duration-150 hover:bg-object-chip-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-object-chip-hover animate-in fade-in-0 animation-duration-250 ease-[cubic-bezier(0.23,1,0.32,1)] fill-mode-both";

/** A source's icon inside a chip: its own small rounded tile. The neutral fill shows only where the favicon is transparent, or behind the globe when there is none. */
export const sourceTileClassName = "size-4.5 rounded-[5px] bg-muted [&:is(span)]:p-[3px] [&:is(span)]:text-muted-foreground";

export function SourceChip({ source = SOURCES[0] }: { source?: StreamingSource }) {
  return (
    <a href={source.href} target="_blank" rel="noreferrer" className={sourceChipClassName}>
      <SourceAvatar source={source} className={sourceTileClassName} />
      <span className="truncate">{source.domain}</span>
    </a>
  );
}

/** The "N sources" toggle: overlapping avatars that open the list of every source below. */
export function SourcesSummary({
  sources,
  label,
  open,
  onOpenChange,
  className,
}: {
  sources: StreamingSource[];
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
      className={cn("flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover", className)}
    >
      <span className="flex -space-x-1">
        {sources.slice(0, 3).map((source, index) => (
          <SourceAvatar
            key={index}
            source={source}
            className="size-3.5 rounded-full bg-surface shadow-[0_0_0_1.5px_var(--canvas)]"
          />
        ))}
      </span>
      <span className="text-[12px] text-ink-2">{label}</span>
    </button>
  );
}

/** Every source, one row each, expanding under the summary. */
export function SourcesList({ sources, open }: { sources: StreamingSource[]; open: boolean }) {
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-300"
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
      }}
      inert={!open}
    >
      <div className="overflow-hidden">
        <div className="mt-1.5 flex flex-col rounded-control bg-inset p-1 shadow-hairline">
          {sources.map((source, index) => {
            const row = (
              <>
                <SourceAvatar source={source} className="size-4 rounded-[4px]" />
                <span className="animated-underline truncate">{source.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3">{source.domain}</span>
              </>
            );
            const rowClassName =
              "flex min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink";
            return source.href ? (
              <a key={index} href={source.href} target="_blank" rel="noreferrer" className={rowClassName}>
                {row}
              </a>
            ) : (
              <button key={index} type="button" onClick={source.onSelect} className={rowClassName}>
                {row}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const ACTION_ICONS: React.ReactNode[] = [
  <g key="copy">
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </g>,
  <path key="retry" d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
  <path
    key="up"
    d="M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z"
  />,
  <path
    key="down"
    d="M17 14V2M9 18.12L10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z"
  />,
];

export default function StreamingText() {
  const [count, setCount] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const done = count >= TOKENS.length;

  useEffect(() => {
    const t = setTimeout(
      () => setCount((c) => (c >= TOKENS.length ? 0 : c + 1)),
      done ? HOLD_MS : WORD_MS,
    );
    return () => clearTimeout(t);
  }, [count, done]);

  return (
    <div className="min-h-[13rem] w-full max-w-95">
      <p className="text-[13px] leading-relaxed text-ink">
        {TOKENS.slice(0, count).map((token, i) =>
          token.cite ? (
            <SourceChip key={i} />
          ) : (
            <span key={i} className="inline animate-in fade-in-0 animation-duration-250 fill-mode-both">
              {token.text}{" "}
            </span>
          ),
        )}
        {!done && (
          <span className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-ink animate-in fade-in-0 animation-duration-150 fill-mode-both" />
        )}
      </p>

      {/* action icons row */}
      <div
        className="mt-2 flex items-center gap-0.5 transition-opacity duration-400"
        style={{ opacity: done ? 1 : 0, pointerEvents: done ? "auto" : "none" }}
      >
        {ACTION_ICONS.map((icon, i) => (
          <button
            key={i}
            type="button"
            aria-label="Action"
            className="flex size-6 items-center justify-center rounded-[6px] text-ink-3
              transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {icon}
            </svg>
          </button>
        ))}
        <SourcesSummary
          sources={SOURCES}
          label="10 sources"
          open={sourcesOpen}
          onOpenChange={setSourcesOpen}
          className="ml-1.5"
        />
      </div>

      <SourcesList sources={SOURCES} open={done && sourcesOpen} />

      {/* follow-ups */}
      <div
        className="mt-2.5 transition-opacity duration-400"
        style={{ opacity: done ? 1 : 0, pointerEvents: done ? "auto" : "none" }}
      >
        <p className="text-[12px] font-medium text-ink-2">Follow-ups</p>
        <div className="mt-0.5 flex flex-col">
          {FOLLOW_UPS.map((text, i) => (
            <button
              key={text}
              className={cn(
                "-mx-1.5 flex items-center gap-2 border-b border-line px-1.5 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-hover-2",
                done ? "animate-in fade-in-0 slide-in-from-bottom-2 animation-duration-350 ease-[cubic-bezier(0.23,1,0.32,1)] fill-mode-both" : "opacity-0",
              )}
              style={done ? { animationDelay: `${i * 90}ms` } : undefined}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--ink-3)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0"
              >
                <path d="M9 10l-5 5 5 5" />
                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              </svg>
              {text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
