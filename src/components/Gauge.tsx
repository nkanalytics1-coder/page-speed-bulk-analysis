import type { CSSProperties } from "react";
import { ratingFor } from "@/lib/lighthouse-scoring";
import { formatScore } from "@/lib/format";

const RING_COLORS = {
  pass: { ring: "#0cce6b", track: "#e9f7ef", text: "#0a7d43" },
  average: { ring: "#ffa400", track: "#fff6e5", text: "#9a6200" },
  fail: { ring: "#ff4e42", track: "#fdecea", text: "#b3231a" },
  none: { ring: "#c7ccd1", track: "#f1f3f4", text: "#5f6771" },
} as const;

const SIZES = {
  sm: { box: 44, ring: 3, font: "text-sm" },
  md: { box: 72, ring: 5, font: "text-xl" },
  lg: { box: 104, ring: 7, font: "text-3xl" },
} as const;

interface GaugeProps {
  score: number | null;
  label?: string;
  size?: keyof typeof SIZES;
}

export function Gauge({ score, label, size = "md" }: GaugeProps) {
  const rating = ratingFor(score);
  const colors = RING_COLORS[rating];
  const dimensions = SIZES[size];
  const percent = score == null ? 0 : Math.round(score * 100);

  const ringStyle = {
    width: dimensions.box,
    height: dimensions.box,
    "--gauge-value": percent,
    "--gauge-color": colors.ring,
    "--gauge-track": colors.track,
  } as CSSProperties;

  const holeStyle = {
    inset: dimensions.ring,
  } as CSSProperties;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="gauge-ring relative rounded-full"
        style={ringStyle}
        role="img"
        aria-label={`${label ?? "Punteggio"}: ${formatScore(score)} su 100`}
      >
        <div
          className="absolute rounded-full bg-card flex items-center justify-center"
          style={holeStyle}
        >
          <span
            className={`${dimensions.font} tabular-nums`}
            style={{ color: colors.text }}
          >
            {formatScore(score)}
          </span>
        </div>
      </div>
      {label ? (
        <span className="text-xs text-ink-muted text-center leading-tight">
          {label}
        </span>
      ) : null}
    </div>
  );
}

/** Quadratino colorato usato nelle tabelle di riepilogo. */
export function ScoreChip({
  score,
  title,
}: {
  score: number | null;
  title?: string;
}) {
  const rating = ratingFor(score);
  const colors = RING_COLORS[rating];

  return (
    <span
      title={title}
      className="inline-flex min-w-9 items-center justify-center rounded px-1.5 py-0.5 text-sm tabular-nums"
      style={{ backgroundColor: colors.track, color: colors.text }}
    >
      {formatScore(score)}
    </span>
  );
}

/** Il triangolo/quadrato/cerchio che Lighthouse usa accanto a ogni audit. */
export function RatingMark({ score }: { score: number | null }) {
  const rating = ratingFor(score);
  const colors = RING_COLORS[rating];

  if (rating === "pass") {
    return (
      <span
        className="mt-1 inline-block size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: colors.ring }}
        aria-hidden
      />
    );
  }
  if (rating === "average") {
    return (
      <span
        className="mt-1 inline-block size-2.5 shrink-0"
        style={{ backgroundColor: colors.ring }}
        aria-hidden
      />
    );
  }
  if (rating === "fail") {
    return (
      <span
        className="mt-1 inline-block size-0 shrink-0"
        style={{
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderBottom: `9px solid ${colors.ring}`,
        }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className="mt-1 inline-block size-2.5 shrink-0 rounded-full border"
      style={{ borderColor: colors.ring }}
      aria-hidden
    />
  );
}
