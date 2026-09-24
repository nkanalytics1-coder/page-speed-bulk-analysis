import {
  METRIC_LABELS,
  RATING_COLORS,
  RATING_LABELS,
  formatMetric,
  type CruxMetricId,
  type CruxRating,
} from "@/lib/crux";
import type { MetricSummary } from "@/lib/template-summary";

/** Esito complessivo sui Core Web Vitals. */
export function CwvBadge({
  passes,
  size = "md",
}: {
  passes: boolean | null;
  size?: "sm" | "md";
}) {
  const style =
    passes === true
      ? { bg: "#e9f7ef", fg: "#0a7d43", text: "Superati" }
      : passes === false
        ? { bg: "#fdecea", fg: "#b3231a", text: "Non superati" }
        : { bg: "#f1f3f4", fg: "#5f6771", text: "Dati insufficienti" };

  return (
    <span
      className={`inline-block rounded ${
        size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm"
      }`}
      style={{ backgroundColor: style.bg, color: style.fg }}
    >
      {style.text}
    </span>
  );
}

/** Una metrica con il suo valore e il colore della valutazione. */
export function MetricCell({
  id,
  value,
  rating,
  samples,
}: {
  id: CruxMetricId;
  value: number | null;
  rating: CruxRating | null;
  samples?: number;
}) {
  if (value == null || rating == null) {
    return <span className="text-sm text-ink-faint">—</span>;
  }

  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ backgroundColor: RATING_COLORS[rating] }}
        title={RATING_LABELS[rating]}
      />
      <span className="text-sm tabular-nums">{formatMetric(id, value)}</span>
      {samples != null && samples > 1 ? (
        <span className="text-xs text-ink-faint">({samples})</span>
      ) : null}
    </span>
  );
}

export function MetricFromSummary({
  summary,
}: {
  summary: MetricSummary | undefined;
}) {
  return (
    <MetricCell
      id={summary?.id ?? "largest_contentful_paint"}
      value={summary?.median ?? null}
      rating={summary?.rating ?? null}
    />
  );
}

/** Barra che mostra come si divide l'LCP fra le sue quattro fasi. */
export function LcpPhaseBar({
  phases,
}: {
  phases: { id: string; label: string; p75: number; share: number }[];
}) {
  if (phases.length === 0) return null;

  const colors = ["#1a73e8", "#8430ce", "#e8710a", "#0a7d43"];

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-alt">
        {phases.map((phase, index) => (
          <span
            key={phase.id}
            style={{
              width: `${phase.share * 100}%`,
              backgroundColor: colors[index % colors.length],
            }}
            title={`${phase.label}: ${Math.round(phase.p75)} ms`}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {phases.map((phase, index) => (
          <li key={phase.id} className="flex items-center gap-1.5 text-xs">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ backgroundColor: colors[index % colors.length] }}
            />
            <span className="text-ink-muted">{phase.label}</span>
            <span className="tabular-nums">{Math.round(phase.p75)} ms</span>
            <span className="text-ink-faint">
              ({Math.round(phase.share * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const CWV_COLUMNS: CruxMetricId[] = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
];

export function CwvHeaderCells() {
  return (
    <>
      {CWV_COLUMNS.map((id) => (
        <th key={id} className="px-3 py-2">
          {METRIC_LABELS[id]}
        </th>
      ))}
    </>
  );
}
