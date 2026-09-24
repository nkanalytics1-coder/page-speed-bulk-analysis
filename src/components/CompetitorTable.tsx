"use client";

import { CWV_COLUMNS, CwvBadge, CwvHeaderCells, MetricCell } from "./CwvBits";
import { METRIC_LABELS, formatMetric, type CruxMetricId, type CruxResult } from "@/lib/crux";

export interface CompetitorRow {
  /** Etichetta mostrata: dominio, o "Tu" per il sito analizzato. */
  label: string;
  isSelf: boolean;
  result: CruxResult | null;
  /** Messaggio quando CrUX non ha dati. */
  miss: string | null;
}

/** Differenza rispetto al proprio valore, con segno e colore. */
function Delta({
  id,
  mine,
  theirs,
}: {
  id: CruxMetricId;
  mine: number | null;
  theirs: number | null;
}) {
  if (mine == null || theirs == null) return null;
  const diff = theirs - mine;
  if (Math.abs(diff) < (id === "cumulative_layout_shift" ? 0.005 : 1)) {
    return <span className="text-xs text-ink-faint">pari</span>;
  }

  // Su tutte queste metriche un valore più basso è migliore: se il competitor
  // ha un valore più alto, siamo noi in vantaggio.
  const weAreBetter = diff > 0;
  return (
    <span
      className="text-xs tabular-nums"
      style={{ color: weAreBetter ? "#0a7d43" : "#b3231a" }}
    >
      {weAreBetter ? "−" : "+"}
      {formatMetric(id, Math.abs(diff))}
    </span>
  );
}

export function CompetitorTable({ rows }: { rows: CompetitorRow[] }) {
  if (rows.length === 0) return null;

  const self = rows.find((row) => row.isSelf) ?? null;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[48rem] text-left">
        <thead className="bg-surface-alt text-xs text-ink-muted">
          <tr>
            <th className="px-3 py-2">Sito</th>
            <th className="px-3 py-2">Ambito</th>
            <th className="px-3 py-2">Core Web Vitals</th>
            <CwvHeaderCells />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className={`border-t border-border ${
                row.isSelf ? "bg-accent-soft" : ""
              }`}
            >
              <td className="px-3 py-3 text-sm">
                {row.label}
                {row.isSelf ? (
                  <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-xs text-white">
                    tu
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-3 text-xs text-ink-muted">
                {row.result
                  ? row.result.scope === "url"
                    ? "Pagina"
                    : "Intero sito"
                  : "—"}
              </td>
              <td className="px-3 py-3">
                {row.result ? (
                  <CwvBadge passes={row.result.passesCwv} size="sm" />
                ) : (
                  <span className="text-xs text-ink-faint">{row.miss}</span>
                )}
              </td>
              {CWV_COLUMNS.map((id) => {
                const metric = row.result?.metrics[id];
                const mine = self?.result?.metrics[id]?.p75 ?? null;
                return (
                  <td key={id} className="px-3 py-3">
                    <div className="flex flex-col gap-0.5">
                      <MetricCell
                        id={id}
                        value={metric?.p75 ?? null}
                        rating={metric?.rating ?? null}
                      />
                      {!row.isSelf ? (
                        <Delta id={id} mine={mine} theirs={metric?.p75 ?? null} />
                      ) : null}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-border bg-surface px-3 py-2 text-xs leading-relaxed text-ink-muted">
        Valori al 75° percentile degli utenti reali di Chrome, ultimi 28 giorni.
        La differenza sotto ogni valore è rispetto al tuo sito: in verde quando
        sei più veloce tu. Dove l&apos;ambito è &quot;Intero sito&quot;, CrUX non
        aveva dati sulla singola pagina e il valore è quello medio del dominio —
        confrontalo con cautela con un dato di pagina.
        {" "}
        {METRIC_LABELS.largest_contentful_paint} e{" "}
        {METRIC_LABELS.interaction_to_next_paint} sono in millisecondi,{" "}
        {METRIC_LABELS.cumulative_layout_shift} è adimensionale.
      </p>
    </div>
  );
}
