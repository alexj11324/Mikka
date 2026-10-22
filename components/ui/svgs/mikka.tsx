import type { SVGProps } from "react";

/** The Mikka mark from app/icon.svg, drawn in the current text color. */
const Mikka = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} viewBox="19.2 19.2 61.6 61.6" fill="currentColor" aria-hidden="true">
    <g opacity={0.15}>
      <circle cx="38" cy="26" r="4.8" />
      <circle cx="50" cy="26" r="4.8" />
      <circle cx="62" cy="26" r="4.8" />
      <circle cx="50" cy="38" r="4.8" />
      <circle cx="38" cy="50" r="4.8" />
      <circle cx="62" cy="50" r="4.8" />
      <circle cx="38" cy="62" r="4.8" />
      <circle cx="50" cy="62" r="4.8" />
      <circle cx="62" cy="62" r="4.8" />
      <circle cx="38" cy="74" r="4.8" />
      <circle cx="50" cy="74" r="4.8" />
      <circle cx="62" cy="74" r="4.8" />
    </g>
    <g>
      <circle cx="26" cy="26" r="4.8" />
      <circle cx="74" cy="26" r="4.8" />
      <circle cx="26" cy="38" r="4.8" />
      <circle cx="38" cy="38" r="4.8" />
      <circle cx="62" cy="38" r="4.8" />
      <circle cx="74" cy="38" r="4.8" />
      <circle cx="26" cy="50" r="4.8" />
      <circle cx="50" cy="50" r="4.8" />
      <circle cx="74" cy="50" r="4.8" />
      <circle cx="26" cy="62" r="4.8" />
      <circle cx="74" cy="62" r="4.8" />
      <circle cx="26" cy="74" r="4.8" />
      <circle cx="74" cy="74" r="4.8" />
    </g>
  </svg>
);

export { Mikka };
