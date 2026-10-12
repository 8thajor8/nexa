export type HolographicFrameVariant = "panel" | "navigation" | "control";

/** Orthogonal vector geometry keeps corner proportions consistent across aspect ratios. */
export function HolographicFrame({ variant = "panel" }: { variant?: HolographicFrameVariant }) {
  return (
    <svg
      className={`holographic-frame holographic-frame--${variant}`}
      data-variant={variant}
      viewBox="0 0 1000 600"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path className="holographic-frame-underlay" d="M1 44V1h103 M1 95V67 M1 531v-27 M1 556v43h103 M999 44V1H896 M999 95V67 M999 531v-27 M999 556v43H896" />
      <path className="holographic-frame-primary" d="M3 34V3h83 M3 98V76 M3 524v-22 M3 566v31h83 M997 34V3h-83 M997 98V76 M997 524v-22 M997 566v31h-83" />
      <path className="holographic-frame-secondary" d="M124 3h136 M304 3h94 M602 3h112 M758 3h88 M3 145v84 M3 356v84 M997 145v75 M997 378v62 M124 597h112 M286 597h142 M602 597h108 M778 597h68" />
      <path className="holographic-frame-detail" d="M3 48h16v-8 M3 552h16v8 M997 48h-16v-8 M997 552h-16v8 M40 3v12h13 M960 3v12h-13 M40 597v-12h13 M960 597v-12h-13" />
      <path className="holographic-frame-node" d="M0 3h7 M3 0v7 M993 3h7 M997 0v7 M0 597h7 M3 593v7 M993 597h7 M997 593v7" />
      <path className="holographic-frame-flare" d="M290 3h9 M294 0v7 M701 3h9 M705 0v7 M3 276h7 M3 273v7 M997 316h-7 M997 313v7" />
    </svg>
  );
}
