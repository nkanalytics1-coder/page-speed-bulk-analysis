import {
  CORE_WEB_VITALS,
  LCP_PHASE_HINTS,
  LCP_PHASE_LABELS,
  ratingFor,
  type CoreWebVital,
  type CruxMetricId,
  type CruxRating,
  type CruxResult,
  type LcpPhaseId,
} from "./crux";
import { DEFAULT_IMPORTANCE, IMPORTANCE_MULTIPLIERS } from "./templates";
import type { Importance, PageType, Template } from "./templates";

/**
 * Sintesi dei dati di campo per template.
 *
 * Le singole pagine dello stesso template variano poco fra loro, ma non sono
 * identiche. Usiamo la mediana dei percentili invece della media perché una
 * sola pagina anomala non deve spostare il verdetto sull'intero template.
 */

export interface MetricSummary {
  id: CruxMetricId;
  median: number;
  rating: CruxRating;
  /** Su quante pagine campionate è stato possibile calcolarla. */
  samples: number;
}

export interface TemplateSummary {
  pattern: string;
  label: string;
  /** Tipo di pagina: proposto dall'euristica, confermato o corretto dall'utente. */
  pageType: string;
  /** Quanto conta che questo template sia veloce, per il business. */
  importance: Importance;
  /** URL totali del sito che ricadono in questo template. */
  totalUrls: number;
  /** URL effettivamente interrogate. */
  sampled: number;
  /** Campioni con dati di campo disponibili. */
  withData: number;
  /** Campioni con dati propri della pagina (non ereditati dal sito). */
  urlScoped: number;
  /**
   * Da dove vengono i numeri.
   *
   * "origin" significa che nessuna pagina campionata aveva dati propri e i
   * valori sono quelli dell'intero dominio: identici per tutti i template, e
   * quindi inutili per confrontarli fra loro. Va detto, non nascosto.
   */
  dataScope: "url" | "mixed" | "origin" | "none";
  metrics: Partial<Record<CruxMetricId, MetricSummary>>;
  /** Campioni che superano i Core Web Vitals. */
  passing: number;
  /** Campioni che non li superano. */
  failing: number;
  /** null quando nessun campione ha dati sufficienti per il verdetto. */
  passesCwv: boolean | null;
  /** Core Web Vitals senza dati su nessun campione. */
  missingCwv: CoreWebVital[];
  /** Le quattro fasi dell'LCP, in mediana sui campioni. */
  lcpPhases: { id: LcpPhaseId; label: string; p75: number; share: number }[];
  /** La fase che pesa di più sull'LCP, con il suggerimento corrispondente. */
  dominantLcpPhase: {
    id: LcpPhaseId;
    label: string;
    share: number;
    medianMs: number;
    hint: string;
  } | null;
  /** URL campionate che non superano i CWV: da qui parte la diagnosi. */
  failingUrls: string[];
  /** Tutte le URL campionate, nell'ordine in cui sono state interrogate. */
  sampleUrls: string[];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const ALL_METRICS: CruxMetricId[] = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
  "first_contentful_paint",
  "experimental_time_to_first_byte",
];

const LCP_PHASES: LcpPhaseId[] = [
  "largest_contentful_paint_image_time_to_first_byte",
  "largest_contentful_paint_image_resource_load_delay",
  "largest_contentful_paint_image_resource_load_duration",
  "largest_contentful_paint_image_element_render_delay",
];

export function summarizeTemplate(
  template: Template,
  results: CruxResult[],
  /** Tipo scelto dall'utente; in assenza si usa quello dedotto dal percorso. */
  pageType?: string,
  /** Importanza scelta dall'utente; in assenza si deriva dal tipo di pagina. */
  importance?: Importance,
): TemplateSummary {
  const type = pageType ?? template.suggestedType;
  const weight =
    importance ?? DEFAULT_IMPORTANCE[type as PageType] ?? "Media";
  const metrics: TemplateSummary["metrics"] = {};

  for (const id of ALL_METRICS) {
    const values = results
      .map((result) => result.metrics[id]?.p75)
      .filter((value): value is number => typeof value === "number");
    if (values.length === 0) continue;

    const value = median(values);
    metrics[id] = {
      id,
      median: value,
      rating: ratingFor(id, value),
      samples: values.length,
    };
  }

  const verdicts = results.map((result) => result.passesCwv);
  const passing = verdicts.filter((v) => v === true).length;
  const failing = verdicts.filter((v) => v === false).length;

  const missingCwv = CORE_WEB_VITALS.filter((id) => !metrics[id]);
  // Il template supera i CWV solo se lo fanno tutte le metriche core sulla
  // mediana. È la stessa regola applicata alla singola pagina.
  const passesCwv =
    missingCwv.length > 0
      ? null
      : CORE_WEB_VITALS.every((id) => metrics[id]?.rating === "good");

  // La fase dominante si calcola sulle mediane, non sulle quote medie:
  // una quota media su pagine con LCP molto diversi non significherebbe nulla.
  const phaseMedians = LCP_PHASES.map((id) => {
    const values = results
      .map((result) => result.lcpPhases.find((phase) => phase.id === id)?.p75)
      .filter((value): value is number => typeof value === "number");
    return { id, medianMs: values.length > 0 ? median(values) : 0, samples: values.length };
  }).filter((phase) => phase.samples > 0);

  const phaseTotal = phaseMedians.reduce((sum, phase) => sum + phase.medianMs, 0);
  const top = phaseMedians.reduce<(typeof phaseMedians)[number] | null>(
    (best, current) => (best == null || current.medianMs > best.medianMs ? current : best),
    null,
  );

  const lcpPhases = phaseMedians.map((phase) => ({
    id: phase.id,
    label: LCP_PHASE_LABELS[phase.id],
    p75: phase.medianMs,
    share: phaseTotal > 0 ? phase.medianMs / phaseTotal : 0,
  }));

  const dominantLcpPhase =
    top && phaseTotal > 0
      ? {
          id: top.id,
          label: LCP_PHASE_LABELS[top.id],
          share: top.medianMs / phaseTotal,
          medianMs: top.medianMs,
          hint: LCP_PHASE_HINTS[top.id],
        }
      : null;

  const failingUrls = results
    .filter((result) => result.passesCwv === false)
    .map((result) => result.requestedUrl);

  const urlScoped = results.filter((result) => result.scope === "url").length;
  const dataScope: TemplateSummary["dataScope"] =
    results.length === 0
      ? "none"
      : urlScoped === results.length
        ? "url"
        : urlScoped === 0
          ? "origin"
          : "mixed";

  return {
    pattern: template.pattern,
    label: template.label,
    pageType: type,
    importance: weight,
    totalUrls: template.urls.length,
    sampled: template.sample.length,
    withData: results.length,
    urlScoped,
    dataScope,
    metrics,
    passing,
    failing,
    passesCwv,
    missingCwv,
    lcpPhases,
    dominantLcpPhase,
    failingUrls,
    sampleUrls: template.sample,
  };
}

/**
 * Ordina i template per urgenza: prima quelli che non superano i CWV, e fra
 * questi quelli che pesano di più, cioè diffusione per importanza. Una
 * correzione su un template diffuso e importante vale più di una su un
 * archivio secondario.
 */
export function sortByUrgency(summaries: TemplateSummary[]): TemplateSummary[] {
  const rank = (summary: TemplateSummary) =>
    summary.passesCwv === false ? 0 : summary.passesCwv === null ? 1 : 2;

  const weight = (summary: TemplateSummary) =>
    summary.totalUrls * IMPORTANCE_MULTIPLIERS[summary.importance];

  return [...summaries].sort(
    (a, b) => rank(a) - rank(b) || weight(b) - weight(a),
  );
}

/**
 * Moltiplicatore di importanza per ogni URL campionata, da passare al piano
 * d'azione: è il ponte fra la scelta fatta sul template e il peso dei singoli
 * audit Lighthouse, che vengono misurati per pagina.
 */
export function importanceByUrl(
  summaries: TemplateSummary[],
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const summary of summaries) {
    const multiplier = IMPORTANCE_MULTIPLIERS[summary.importance];
    for (const url of summary.sampleUrls) map[url] = multiplier;
  }
  return map;
}
