"use client";

import { useState } from "react";
import { CwvBadge, CwvHeaderCells, LcpPhaseBar, MetricFromSummary } from "./CwvBits";
import { CWV_COLUMNS } from "./CwvBits";
import { METRIC_FULL_LABELS, formatMetric } from "@/lib/crux";
import { shortUrl } from "@/lib/format";
import { IMPORTANCE_LEVELS, PAGE_TYPES } from "@/lib/templates";
import type { Importance } from "@/lib/templates";
import type { TemplateSummary } from "@/lib/template-summary";

interface Props {
  summaries: TemplateSummary[];
  /** Avvia la diagnosi Lighthouse sulle URL campionate di un template. */
  onDiagnose: (summary: TemplateSummary) => void;
  /** Correzione del tipo di pagina proposto dall'euristica. */
  onTypeChange: (pattern: string, pageType: string) => void;
  /** Correzione dell'importanza per il business. */
  onImportanceChange: (pattern: string, importance: Importance) => void;
  /** Pattern dei template già diagnosticati o in corso. */
  diagnosing: Set<string>;
  diagnosed: Set<string>;
}

const IMPORTANCE_STYLES: Record<Importance, string> = {
  Alta: "border-fail text-fail",
  Media: "border-border text-ink",
  Bassa: "border-border text-ink-faint",
};

function Row({
  summary,
  onDiagnose,
  onTypeChange,
  onImportanceChange,
  diagnosing,
  diagnosed,
}: {
  summary: TemplateSummary;
  onDiagnose: (summary: TemplateSummary) => void;
  onTypeChange: (pattern: string, pageType: string) => void;
  onImportanceChange: (pattern: string, importance: Importance) => void;
  diagnosing: boolean;
  diagnosed: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr
        className="cursor-pointer border-t border-border align-top hover:bg-surface-alt"
        onClick={() => setOpen((value) => !value)}
      >
        <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
          <select
            value={summary.pageType}
            onChange={(event) => onTypeChange(summary.pattern, event.target.value)}
            className="w-full rounded border border-border bg-card px-2 py-1 text-sm"
          >
            {PAGE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </td>
        <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
          <select
            value={summary.importance}
            onChange={(event) =>
              onImportanceChange(summary.pattern, event.target.value as Importance)
            }
            className={`w-full rounded border bg-card px-2 py-1 text-sm ${
              IMPORTANCE_STYLES[summary.importance]
            }`}
          >
            {IMPORTANCE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </td>
        <td className="px-3 py-3">
          <span className="text-sm">{summary.label}</span>
          <span className="mt-0.5 block font-mono text-xs text-ink-faint">
            {summary.pattern}
          </span>
        </td>
        <td className="px-3 py-3 text-sm tabular-nums">
          {summary.totalUrls}
          <span className="ml-1 text-xs text-ink-faint">
            ({summary.sampled} analizzate)
          </span>
        </td>
        <td className="px-3 py-3">
          <CwvBadge passes={summary.passesCwv} size="sm" />
          {summary.dataScope === "origin" ? (
            <span
              className="mt-1 block text-xs text-average"
              title="CrUX non ha dati sulle singole pagine di questo template: i valori sono quelli dell'intero sito, uguali per tutti i template."
            >
              dato dell&apos;intero sito
            </span>
          ) : summary.dataScope === "mixed" ? (
            <span className="mt-1 block text-xs text-ink-faint">
              {summary.urlScoped}/{summary.withData} con dati propri
            </span>
          ) : null}
        </td>
        {CWV_COLUMNS.map((id) => (
          <td key={id} className="px-3 py-3">
            <MetricFromSummary summary={summary.metrics[id]} />
          </td>
        ))}
        <td className="px-3 py-3 text-xs text-ink-muted">
          {summary.dominantLcpPhase ? summary.dominantLcpPhase.label : "—"}
        </td>
        <td className="px-3 py-3 text-right">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDiagnose(summary);
            }}
            disabled={diagnosing}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-alt disabled:opacity-40"
          >
            {diagnosing ? "In corso…" : diagnosed ? "Rianalizza" : "Diagnosi"}
          </button>
        </td>
      </tr>

      {open ? (
        <tr className="border-t border-border bg-surface-alt">
          <td colSpan={10} className="px-3 py-4">
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-xs text-ink-muted">
                  Composizione dell&apos;LCP (mediana sui campioni)
                </h4>
                {summary.dominantLcpPhase ? (
                  <>
                    <LcpPhaseBar phases={summary.lcpPhases} />
                    <p className="mt-3 text-sm">
                      La fase dominante è{" "}
                      <strong>{summary.dominantLcpPhase.label}</strong> con{" "}
                      {Math.round(summary.dominantLcpPhase.medianMs)} ms (
                      {Math.round(summary.dominantLcpPhase.share * 100)}% del
                      totale).
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                      {summary.dominantLcpPhase.hint}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-ink-muted">
                    Nessun dato sulla composizione dell&apos;LCP per questo
                    template.
                  </p>
                )}
              </div>

              <div>
                <h4 className="mb-2 text-xs text-ink-muted">Altre metriche</h4>
                <ul className="space-y-1">
                  {(["first_contentful_paint", "experimental_time_to_first_byte"] as const).map(
                    (id) => {
                      const metric = summary.metrics[id];
                      return (
                        <li key={id} className="flex justify-between gap-4 text-sm">
                          <span className="text-ink-muted">
                            {METRIC_FULL_LABELS[id]}
                          </span>
                          <span className="tabular-nums">
                            {metric ? formatMetric(id, metric.median) : "—"}
                          </span>
                        </li>
                      );
                    },
                  )}
                  <li className="flex justify-between gap-4 text-sm">
                    <span className="text-ink-muted">Campioni con dati propri</span>
                    <span className="tabular-nums">
                      {summary.urlScoped} / {summary.sampled}
                    </span>
                  </li>
                </ul>

                {summary.urlScoped < summary.withData ? (
                  <p className="mt-3 text-xs leading-relaxed text-ink-faint">
                    Per {summary.withData - summary.urlScoped} campioni CrUX non
                    ha dati sulla singola pagina, quindi è stato usato il dato
                    dell&apos;intero sito. Il valore resta indicativo del
                    template, ma meno preciso.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-4">
              <h4 className="mb-2 text-xs text-ink-muted">
                Pagine campionate ({summary.sampleUrls.length})
              </h4>
              <ul className="space-y-0.5">
                {summary.sampleUrls.map((url) => (
                  <li key={url} className="text-xs">
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className={`underline underline-offset-2 ${
                        summary.failingUrls.includes(url)
                          ? "text-fail"
                          : "text-accent"
                      }`}
                    >
                      {shortUrl(url, 90)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function TemplateTable({
  summaries,
  onDiagnose,
  onTypeChange,
  onImportanceChange,
  diagnosing,
  diagnosed,
}: Props) {
  if (summaries.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[74rem] text-left">
        <thead className="bg-surface-alt text-xs text-ink-muted">
          <tr>
            <th className="px-3 py-2">Tipo di pagina</th>
            <th className="px-3 py-2" title="Quanto conta per il business che queste pagine siano veloci. Incide sull'ordine degli interventi.">
              Importanza
            </th>
            <th className="px-3 py-2">Template</th>
            <th className="px-3 py-2">Pagine</th>
            <th className="px-3 py-2">Core Web Vitals</th>
            <CwvHeaderCells />
            <th className="px-3 py-2">Collo di bottiglia LCP</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {summaries.map((summary) => (
            <Row
              key={summary.pattern}
              summary={summary}
              onDiagnose={onDiagnose}
              onTypeChange={onTypeChange}
              onImportanceChange={onImportanceChange}
              diagnosing={diagnosing.has(summary.pattern)}
              diagnosed={diagnosed.has(summary.pattern)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
